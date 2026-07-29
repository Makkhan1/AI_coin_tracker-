import json
import os
import re
import inspect
import time
import html
import asyncio
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime
from typing import Any, Dict, List, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from groq import Groq
from pydantic import BaseModel, Field

load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

COINGECKO_API = "https://api.coingecko.com/api/v3"
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")
MAX_COMPLETION_TOKENS = int(os.getenv("GROQ_MAX_COMPLETION_TOKENS", "1400"))
REQUEST_TIMEOUT = float(os.getenv("HTTP_TIMEOUT_SECONDS", "12"))
NEWS_CACHE_TTL_SECONDS = int(os.getenv("NEWS_CACHE_TTL_SECONDS", "600"))
FRONTEND_ORIGINS = [
    origin.strip()
    for origin in os.getenv("FRONTEND_ORIGIN", "http://localhost:3000").split(",")
    if origin.strip()
]
FRONTEND_ORIGIN_REGEX = os.getenv("FRONTEND_ORIGIN_REGEX") or None

CRYPTO_NEWS_FEEDS = [
    {"source": "Cointelegraph", "url": "https://cointelegraph.com/rss"},
    {"source": "Decrypt", "url": "https://decrypt.co/feed"},
    {"source": "CryptoSlate", "url": "https://cryptoslate.com/feed"},
    {"source": "Bitcoin Magazine", "url": "https://bitcoinmagazine.com/.rss/full/"},
]

NEWS_CACHE: Dict[str, Any] = {"expires_at": 0.0, "items": []}

app = FastAPI(title="AI Coin Tracker Advisor API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=FRONTEND_ORIGINS,
    allow_origin_regex=FRONTEND_ORIGIN_REGEX,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatMessage(BaseModel):
    role: str
    content: str


class AssetContext(BaseModel):
    id: Optional[str] = None
    name: Optional[str] = None
    symbol: Optional[str] = None
    mode: Optional[str] = None
    current_price: Optional[float] = None
    price_change_percentage_24h: Optional[float] = None
    market_cap: Optional[float] = None
    total_volume: Optional[float] = None
    topCoins: Optional[List[Dict[str, Any]]] = None
    comparedAssets: Optional[List[Dict[str, Any]]] = None
    watchlistAssets: Optional[List[Dict[str, Any]]] = None


class AdvisorRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    asset: Optional[AssetContext] = None
    messages: List[ChatMessage] = Field(default_factory=list)


def _sse(event: str, payload: Dict[str, Any]) -> str:
    return f"event: {event}\ndata: {json.dumps(payload)}\n\n"


def _clean_html(value: Optional[str], max_length: int = 900) -> str:
    if not value:
        return "No description available."
    text = re.sub(r"<[^>]+>", " ", value)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_length:
        return text
    return f"{text[:max_length].rsplit(' ', 1)[0]}..."


def _plain_text(value: Optional[str], max_length: int = 220) -> str:
    if not value:
        return ""
    text = html.unescape(value)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_length:
        return text
    return f"{text[:max_length].rsplit(' ', 1)[0]}..."


def _published_timestamp(value: Optional[str]) -> float:
    if not value:
        return 0.0
    try:
        return parsedate_to_datetime(value).timestamp()
    except Exception:
        return 0.0


def _xml_text(node: ET.Element, path: str) -> str:
    found = node.find(path)
    return found.text.strip() if found is not None and found.text else ""


def _parse_feed_items(feed_xml: str, source_name: str) -> List[Dict[str, Any]]:
    try:
        root = ET.fromstring(feed_xml)
    except ET.ParseError:
        return []

    items: List[Dict[str, Any]] = []
    channel_items = root.findall(".//item")
    atom_entries = root.findall(".//{http://www.w3.org/2005/Atom}entry")

    for item in channel_items:
        title = _plain_text(_xml_text(item, "title"), 140)
        link = _xml_text(item, "link")
        published = _xml_text(item, "pubDate")
        summary = _plain_text(
            _xml_text(item, "description") or _xml_text(item, "summary"),
            180,
        )

        if title and link:
            items.append(
                {
                    "title": title,
                    "url": link,
                    "source": source_name,
                    "summary": summary,
                    "published": published,
                    "published_ts": _published_timestamp(published),
                }
            )

    for entry in atom_entries:
        title = _plain_text(_xml_text(entry, "{http://www.w3.org/2005/Atom}title"), 140)
        link_node = entry.find("{http://www.w3.org/2005/Atom}link")
        link = link_node.attrib.get("href", "") if link_node is not None else ""
        published = _xml_text(entry, "{http://www.w3.org/2005/Atom}updated") or _xml_text(
            entry, "{http://www.w3.org/2005/Atom}published"
        )
        summary = _plain_text(
            _xml_text(entry, "{http://www.w3.org/2005/Atom}summary"),
            180,
        )

        if title and link:
            items.append(
                {
                    "title": title,
                    "url": link,
                    "source": source_name,
                    "summary": summary,
                    "published": published,
                    "published_ts": _published_timestamp(published),
                }
            )

    return items


def _news_score(item: Dict[str, Any], asset_name: Optional[str], asset_symbol: Optional[str]) -> float:
    title_summary = f"{item.get('title', '')} {item.get('summary', '')}".lower()
    score = item.get("published_ts") or 0

    for keyword in ["bitcoin", "ethereum", "crypto", "market", "etf", "sec", "defi", "stablecoin"]:
        if keyword in title_summary:
            score += 5000

    for keyword in [asset_name, asset_symbol]:
        if keyword and str(keyword).lower() in title_summary:
            score += 20000

    return score


async def _get_crypto_news(
    limit: int = 12,
    asset_name: Optional[str] = None,
    asset_symbol: Optional[str] = None,
) -> List[Dict[str, Any]]:
    now = time.time()
    if NEWS_CACHE["expires_at"] > now and NEWS_CACHE["items"]:
        items = NEWS_CACHE["items"]
    else:
        items = []
        headers = {"User-Agent": "AI-Coin-Tracker/1.0"}
        async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT, follow_redirects=True) as client:
            responses = await asyncio.gather(
                *[
                    client.get(feed["url"], headers=headers)
                    for feed in CRYPTO_NEWS_FEEDS
                ],
                return_exceptions=True,
            )

        for feed, response in zip(CRYPTO_NEWS_FEEDS, responses):
            if isinstance(response, Exception) or response.status_code >= 400:
                continue
            items.extend(_parse_feed_items(response.text, feed["source"]))

        seen = set()
        deduped = []
        for item in items:
            key = item["url"].split("?")[0]
            if key in seen:
                continue
            seen.add(key)
            deduped.append(item)

        NEWS_CACHE["items"] = deduped
        NEWS_CACHE["expires_at"] = now + NEWS_CACHE_TTL_SECONDS
        items = deduped

    ranked = sorted(
        items,
        key=lambda item: _news_score(item, asset_name, asset_symbol),
        reverse=True,
    )
    return ranked[: max(1, min(limit, 24))]


def _format_usd(value: Optional[float]) -> str:
    if value is None:
        return "unknown"
    if abs(value) >= 1:
        return f"${value:,.2f}"
    return f"${value:,.8f}".rstrip("0").rstrip(".")


def _format_pct(value: Optional[float]) -> str:
    if value is None:
        return "unknown"
    return f"{value:.2f}%"


def _clamp(value: float, lower: float = -1.0, upper: float = 1.0) -> float:
    return max(lower, min(upper, value))


async def _coingecko_get(path: str, params: Optional[Dict[str, Any]] = None) -> Any:
    headers = {}
    demo_key = os.getenv("COINGECKO_DEMO_API_KEY")
    if demo_key:
        headers["x-cg-demo-api-key"] = demo_key

    async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT) as client:
        try:
            response = await client.get(
                f"{COINGECKO_API}{path}", params=params, headers=headers
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            detail = exc.response.text
            if exc.response.status_code == 429:
                detail = (
                    "CoinGecko rate limit reached. Wait a minute and retry, "
                    "or add COINGECKO_DEMO_API_KEY to backend/.env."
                )
            raise HTTPException(status_code=exc.response.status_code, detail=detail)
        except httpx.RequestError as exc:
            raise HTTPException(
                status_code=502,
                detail=f"Could not reach CoinGecko: {exc}",
            )
        return response.json()


def _frontend_asset_summary(asset: Optional[AssetContext]) -> str:
    if not asset:
        return "Frontend context: no active asset was provided."

    parts = [
        f"Frontend active mode: {asset.mode or 'unknown'}",
        f"Frontend active target: {asset.name or asset.id or 'Crypto Market'}",
    ]

    if asset.symbol:
        parts.append(f"Symbol: {asset.symbol.upper()}")
    if asset.current_price is not None:
        parts.append(f"Price: {_format_usd(asset.current_price)}")
    if asset.price_change_percentage_24h is not None:
        parts.append(f"24h change: {_format_pct(asset.price_change_percentage_24h)}")
    if asset.market_cap is not None:
        parts.append(f"Market cap: {_format_usd(asset.market_cap)}")
    if asset.total_volume is not None:
        parts.append(f"24h volume: {_format_usd(asset.total_volume)}")

    if asset.topCoins:
        top = ", ".join(
            f"{coin.get('name', coin.get('id', 'asset'))} ({_format_pct(coin.get('price_change_percentage_24h'))})"
            for coin in asset.topCoins[:8]
        )
        parts.append(f"Visible market leaders: {top}")

    if asset.comparedAssets:
        compared = ", ".join(
            f"{coin.get('name', coin.get('id', 'asset'))} at {_format_usd(coin.get('current_price'))}"
            for coin in asset.comparedAssets[:4]
        )
        parts.append(f"Compared assets: {compared}")

    if asset.watchlistAssets:
        watchlist = ", ".join(
            f"{coin.get('name', coin.get('id', 'asset'))} ({_format_pct(coin.get('price_change_percentage_24h'))})"
            for coin in asset.watchlistAssets[:10]
        )
        parts.append(f"Watchlist assets: {watchlist}")

    return "\n".join(parts)


async def _market_context() -> Dict[str, Any]:
    markets = await _coingecko_get(
        "/coins/markets",
        {
            "vs_currency": "usd",
            "order": "market_cap_desc",
            "per_page": 10,
            "page": 1,
            "sparkline": "false",
            "price_change_percentage": "24h,7d",
        },
    )

    changes = [
        coin.get("price_change_percentage_24h")
        for coin in markets
        if isinstance(coin.get("price_change_percentage_24h"), (int, float))
    ]
    average_24h = sum(changes) / len(changes) if changes else 0
    score = _clamp(average_24h / 8)

    summary_lines = [
        "Live market snapshot from CoinGecko:",
        *[
            (
                f"- {coin.get('name')} ({str(coin.get('symbol', '')).upper()}): "
                f"{_format_usd(coin.get('current_price'))}, "
                f"24h {_format_pct(coin.get('price_change_percentage_24h'))}, "
                f"7d {_format_pct(coin.get('price_change_percentage_7d_in_currency'))}"
            )
            for coin in markets[:10]
        ],
    ]

    return {
        "summary": "\n".join(summary_lines),
        "sentiment": {
            "label": _sentiment_label(score),
            "score": round(score, 2),
            "basis": "Average 24h move across the top market-cap assets.",
        },
    }


def _sentiment_label(score: float) -> str:
    if score >= 0.35:
        return "Bullish"
    if score <= -0.35:
        return "Bearish"
    return "Neutral"


def _coin_sentiment_score(coin: Dict[str, Any], chart: Dict[str, Any]) -> Dict[str, Any]:
    market_data = coin.get("market_data", {})
    change_24h = market_data.get("price_change_percentage_24h") or 0
    change_7d = market_data.get("price_change_percentage_7d") or 0
    change_30d = market_data.get("price_change_percentage_30d") or 0
    vote_up = coin.get("sentiment_votes_up_percentage")
    vote_down = coin.get("sentiment_votes_down_percentage")

    vote_component = 0
    if isinstance(vote_up, (int, float)) and isinstance(vote_down, (int, float)):
        vote_component = (vote_up - vote_down) / 100

    price_component = (change_24h / 8) * 0.45 + (change_7d / 18) * 0.35 + (change_30d / 35) * 0.2
    chart_prices = chart.get("prices") or []
    trend_component = 0
    if len(chart_prices) >= 2:
        start = chart_prices[0][1]
        end = chart_prices[-1][1]
        if start:
            trend_component = _clamp(((end - start) / start) / 0.35)

    score = _clamp((price_component * 0.65) + (vote_component * 0.2) + (trend_component * 0.15))
    return {
        "label": _sentiment_label(score),
        "score": round(score, 2),
        "basis": (
            f"24h {_format_pct(change_24h)}, 7d {_format_pct(change_7d)}, "
            f"30d {_format_pct(change_30d)}, community vote "
            f"{_format_pct(vote_up)} up / {_format_pct(vote_down)} down."
        ),
    }


async def _coin_context(asset_id: str) -> Dict[str, Any]:
    coin = await _coingecko_get(
        f"/coins/{asset_id}",
        {
            "localization": "false",
            "tickers": "false",
            "market_data": "true",
            "community_data": "true",
            "developer_data": "false",
            "sparkline": "false",
        },
    )
    chart = await _coingecko_get(
        f"/coins/{asset_id}/market_chart",
        {"vs_currency": "usd", "days": "30", "interval": "daily"},
    )

    market_data = coin.get("market_data", {})
    current_price = (market_data.get("current_price") or {}).get("usd")
    market_cap = (market_data.get("market_cap") or {}).get("usd")
    total_volume = (market_data.get("total_volume") or {}).get("usd")

    context = [
        f"Live asset snapshot from CoinGecko for {coin.get('name')} ({str(coin.get('symbol', '')).upper()}):",
        f"- Rank: {coin.get('market_cap_rank') or 'unknown'}",
        f"- Current price: {_format_usd(current_price)}",
        f"- 24h change: {_format_pct(market_data.get('price_change_percentage_24h'))}",
        f"- 7d change: {_format_pct(market_data.get('price_change_percentage_7d'))}",
        f"- 30d change: {_format_pct(market_data.get('price_change_percentage_30d'))}",
        f"- Market cap: {_format_usd(market_cap)}",
        f"- 24h volume: {_format_usd(total_volume)}",
        f"- Genesis date: {coin.get('genesis_date') or 'unknown'}",
        f"- Categories: {', '.join((coin.get('categories') or [])[:6]) or 'unknown'}",
        f"- Summary/history: {_clean_html((coin.get('description') or {}).get('en'))}",
    ]

    return {
        "summary": "\n".join(context),
        "sentiment": _coin_sentiment_score(coin, chart),
    }


async def _build_intelligence(asset: Optional[AssetContext]) -> Dict[str, Any]:
    asset_id = (asset.id if asset else None) or ""
    general_modes = {"", "market", "home", "watchlist", "compare"}

    try:
        if asset_id not in general_modes:
            live_context = await _coin_context(asset_id)
        else:
            live_context = await _market_context()
    except Exception as exc:
        live_context = {
            "summary": f"CoinGecko live context is unavailable right now: {exc}",
            "sentiment": {
                "label": "Unavailable",
                "score": 0,
                "basis": "Live data request failed.",
            },
        }

    live_context["frontend"] = _frontend_asset_summary(asset)
    return live_context


def _system_prompt() -> str:
    return (
        "You are AI Advisor inside a crypto dashboard. Be concise, specific, and objective. "
        "Use the provided live market context for current prices, trend, sentiment, and asset history. "
        "If live context is missing, say that clearly. Do not invent prices, news, or certainty. "
        "You are not a financial adviser and must not tell the user to buy, sell, or hold. "
        "When a user asks for a recommendation, summarize evidence, risks, possible scenarios, "
        "and what data they should verify next. Prefer concise headings and bullet lists over wide "
        "Markdown tables because the response is displayed inside a narrow chat panel."
    )


def _build_messages(request: AdvisorRequest, intelligence: Dict[str, Any]) -> List[Dict[str, str]]:
    recent_messages = [
        {"role": msg.role, "content": msg.content}
        for msg in request.messages[-8:]
        if msg.role in {"user", "assistant"} and msg.content.strip()
    ]

    context = (
        "FRONTEND CONTEXT\n"
        f"{intelligence['frontend']}\n\n"
        "LIVE DATA CONTEXT\n"
        f"{intelligence['summary']}\n\n"
        "SENTIMENT SIGNAL\n"
        f"{json.dumps(intelligence['sentiment'])}\n\n"
        f"USER QUESTION\n{request.message}"
    )

    return [{"role": "system", "content": _system_prompt()}, *recent_messages, {"role": "user", "content": context}]


def _groq_completion_kwargs(client: Groq, messages: List[Dict[str, str]]) -> Dict[str, Any]:
    create_signature = inspect.signature(client.chat.completions.create)
    supported_args = create_signature.parameters
    reasoning_effort = os.getenv("GROQ_REASONING_EFFORT", "medium")

    kwargs: Dict[str, Any] = {
        "model": GROQ_MODEL,
        "messages": messages,
        "temperature": float(os.getenv("GROQ_TEMPERATURE", "0.7")),
        "top_p": float(os.getenv("GROQ_TOP_P", "1")),
        "stream": True,
        "stop": None,
    }

    if "max_completion_tokens" in supported_args:
        kwargs["max_completion_tokens"] = MAX_COMPLETION_TOKENS
    else:
        kwargs["max_tokens"] = MAX_COMPLETION_TOKENS

    if "reasoning_effort" in supported_args:
        kwargs["reasoning_effort"] = reasoning_effort
    elif "extra_body" in supported_args:
        kwargs["extra_body"] = {"reasoning_effort": reasoning_effort}

    return kwargs


@app.get("/health")
def health() -> Dict[str, str]:
    return {"status": "ok", "model": GROQ_MODEL}


@app.get("/api/advisor/sentiment")
async def advisor_sentiment(asset_id: Optional[str] = None, asset_name: Optional[str] = None) -> Dict[str, Any]:
    intelligence = await _build_intelligence(AssetContext(id=asset_id, name=asset_name))
    return intelligence["sentiment"]


@app.get("/api/news/crypto")
async def crypto_news(
    limit: int = 12,
    asset_name: Optional[str] = None,
    asset_symbol: Optional[str] = None,
) -> Dict[str, Any]:
    items = await _get_crypto_news(limit, asset_name, asset_symbol)
    return {"items": items}


@app.get("/api/coins/markets")
async def proxy_coin_markets(
    vs_currency: str = "usd",
    order: str = "market_cap_desc",
    per_page: int = 100,
    page: int = 1,
    sparkline: str = "false",
    price_change_percentage: Optional[str] = None,
) -> Any:
    params: Dict[str, Any] = {
        "vs_currency": vs_currency,
        "order": order,
        "per_page": per_page,
        "page": page,
        "sparkline": sparkline,
    }
    if price_change_percentage:
        params["price_change_percentage"] = price_change_percentage
    return await _coingecko_get("/coins/markets", params)


@app.get("/api/coins/{asset_id}/market_chart")
async def proxy_coin_market_chart(
    asset_id: str,
    vs_currency: str = "usd",
    days: str = "30",
    interval: str = "daily",
) -> Any:
    return await _coingecko_get(
        f"/coins/{asset_id}/market_chart",
        {
            "vs_currency": vs_currency,
            "days": days,
            "interval": interval,
        },
    )


@app.get("/api/coins/{asset_id}")
async def proxy_coin(asset_id: str) -> Any:
    return await _coingecko_get(
        f"/coins/{asset_id}",
        {
            "localization": "false",
            "tickers": "false",
            "market_data": "true",
            "community_data": "true",
            "developer_data": "false",
            "sparkline": "false",
        },
    )


@app.post("/api/advisor/chat")
async def advisor_chat(request: AdvisorRequest) -> StreamingResponse:
    intelligence = await _build_intelligence(request.asset)
    messages = _build_messages(request, intelligence)

    def generate():
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key:
            yield _sse(
                "error",
                {
                    "message": (
                        "Missing GROQ_API_KEY. Add it to backend/.env and restart the FastAPI server."
                    )
                },
            )
            yield _sse("done", {})
            return

        try:
            client = Groq(api_key=api_key)
            completion = client.chat.completions.create(
                **_groq_completion_kwargs(client, messages)
            )

            yield _sse("meta", {"sentiment": intelligence["sentiment"]})
            for chunk in completion:
                token = chunk.choices[0].delta.content or ""
                if token:
                    yield _sse("token", {"content": token})
            yield _sse("done", {})
        except Exception as exc:
            yield _sse("error", {"message": str(exc)})
            yield _sse("done", {})

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
