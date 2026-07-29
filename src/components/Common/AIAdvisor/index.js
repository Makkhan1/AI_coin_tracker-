import React, { useEffect, useMemo, useRef, useState } from "react";
import AutoAwesomeRoundedIcon from "@mui/icons-material/AutoAwesomeRounded";
import ChatBubbleRoundedIcon from "@mui/icons-material/ChatBubbleRounded";
import CloseFullscreenRoundedIcon from "@mui/icons-material/CloseFullscreenRounded";
import CloseRoundedIcon from "@mui/icons-material/CloseRounded";
import NewspaperRoundedIcon from "@mui/icons-material/NewspaperRounded";
import OpenInNewRoundedIcon from "@mui/icons-material/OpenInNewRounded";
import OpenInFullRoundedIcon from "@mui/icons-material/OpenInFullRounded";
import QueryStatsRoundedIcon from "@mui/icons-material/QueryStatsRounded";
import RefreshRoundedIcon from "@mui/icons-material/RefreshRounded";
import SendRoundedIcon from "@mui/icons-material/SendRounded";
import { motion, AnimatePresence } from "framer-motion";
import { useAsset } from "../../../context/AssetContext";
import { API_BASE_URL } from "../../../functions/apiConfig";
import "./styles.css";

const SPRING_TRANSITION = {
  type: "spring",
  bounce: 0.2,
  duration: 0.6,
};

const INITIAL_MESSAGE =
  "I’m your AI market assistant. Ask about the active asset, recent price action, sentiment, history, or risk factors. I summarize data and context without giving personal financial advice.";

const DISPLAY_INITIAL_MESSAGE = INITIAL_MESSAGE.replace("\u00e2\u20ac\u2122", "'");

const ADVISOR_TABS = [
  { id: "chat", label: "Chat", Icon: ChatBubbleRoundedIcon },
  { id: "sentiment", label: "Sentiment", Icon: QueryStatsRoundedIcon },
  { id: "news", label: "News", Icon: NewspaperRoundedIcon },
];

const makeMessage = (role, content) => ({
  id: `${role}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  role,
  content,
});

function sentimentClass(score) {
  if (score >= 0.35) return "bullish";
  if (score <= -0.35) return "bearish";
  return "neutral";
}

function formatCurrency(value) {
  if (typeof value !== "number") return null;
  if (Math.abs(value) >= 1) {
    return value.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 2,
    });
  }
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 8 })}`;
}

function formatPercent(value) {
  if (typeof value !== "number") return null;
  return `${value.toFixed(2)}%`;
}

function parseInlineMarkdown(text) {
  const tokenRegex =
    /(`[^`]+`|\*\*[^*]+?\*\*|\$[A-Z][A-Z0-9]{1,9}\b|\b\d+(?:\.\d+)?%?\b)/g;
  const nodes = [];
  let lastIndex = 0;
  let match;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];

    if (token.startsWith("**") && token.endsWith("**")) {
      nodes.push(
        <strong className="ai-advisor-md-bold" key={`${token}-${match.index}`}>
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith("`") && token.endsWith("`")) {
      nodes.push(
        <code className="ai-advisor-md-inline-code" key={`${token}-${match.index}`}>
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("$")) {
      nodes.push(
        <span className="ai-advisor-md-asset" key={`${token}-${match.index}`}>
          {token}
        </span>
      );
    } else {
      nodes.push(
        <span className="ai-advisor-md-number" key={`${token}-${match.index}`}>
          {token}
        </span>
      );
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function parseMarkdownBlocks(content) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let index = 0;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({
        type: "paragraph",
        text: paragraph.join("\n").trim(),
      });
      paragraph = [];
    }
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fenceMatch = trimmed.match(/^```(\w+)?/);
    if (fenceMatch) {
      flushParagraph();
      const codeLines = [];
      const language = fenceMatch[1] || "";
      index += 1;

      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) index += 1;

      blocks.push({
        type: "code",
        language,
        text: codeLines.join("\n"),
      });
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        type: "heading",
        level: headingMatch[1].length,
        text: headingMatch[2],
      });
      index += 1;
      continue;
    }

    const isTableRow = trimmed.startsWith("|") && trimmed.endsWith("|");
    const nextLine = lines[index + 1]?.trim() || "";
    const isDividerRow =
      isTableRow && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(nextLine);

    if (isDividerRow) {
      flushParagraph();
      const parseRow = (row) =>
        row
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((cell) => cell.trim());

      const headers = parseRow(trimmed);
      const rows = [];
      index += 2;

      while (index < lines.length) {
        const row = lines[index].trim();
        if (!row.startsWith("|") || !row.endsWith("|")) break;
        rows.push(parseRow(row));
        index += 1;
      }

      blocks.push({ type: "table", headers, rows });
      continue;
    }

    const unorderedMatch = trimmed.match(/^[-*]\s+(.+)/);
    if (unorderedMatch) {
      flushParagraph();
      const items = [];

      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^[-*]\s+(.+)/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }

      blocks.push({ type: "unordered-list", items });
      continue;
    }

    const orderedMatch = trimmed.match(/^\d+[.)]\s+(.+)/);
    if (orderedMatch) {
      flushParagraph();
      const items = [];

      while (index < lines.length) {
        const itemMatch = lines[index].trim().match(/^\d+[.)]\s+(.+)/);
        if (!itemMatch) break;
        items.push(itemMatch[1]);
        index += 1;
      }

      blocks.push({ type: "ordered-list", items });
      continue;
    }

    paragraph.push(line);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function pipeParagraphToTable(text) {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("|"))
    .map((line) =>
      line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim())
    )
    .filter((row) => row.some(Boolean));

  if (rows.length < 2) return null;

  const headers = rows[0];
  const bodyRows = rows
    .slice(1)
    .filter(
      (row) =>
        !row.every((cell) => /^:?-{2,}:?$/.test(cell.replace(/\s/g, "")))
    );

  if (headers.length < 2 || bodyRows.length < 1) return null;

  return { headers, rows: bodyRows };
}

function MessageContent({ content }) {
  if (!content) {
    return <span className="ai-advisor-thinking">Thinking...</span>;
  }

  return (
    <div className="ai-advisor-md">
      {parseMarkdownBlocks(content).map((block, blockIndex) => {
        if (block.type === "heading") {
          return (
            <p
              className={`ai-advisor-md-heading ai-advisor-md-heading-${block.level}`}
              key={`${block.type}-${blockIndex}`}
            >
              {parseInlineMarkdown(block.text)}
            </p>
          );
        }

        if (block.type === "unordered-list") {
          return (
            <ul className="ai-advisor-md-list" key={`${block.type}-${blockIndex}`}>
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{parseInlineMarkdown(item)}</li>
              ))}
            </ul>
          );
        }

        if (block.type === "ordered-list") {
          return (
            <ol
              className="ai-advisor-md-list ai-advisor-md-ordered-list"
              key={`${block.type}-${blockIndex}`}
            >
              {block.items.map((item, itemIndex) => (
                <li key={`${item}-${itemIndex}`}>{parseInlineMarkdown(item)}</li>
              ))}
            </ol>
          );
        }

        if (block.type === "table") {
          return (
            <div className="ai-advisor-md-table-wrap" key={`${block.type}-${blockIndex}`}>
              <table className="ai-advisor-md-table">
                <thead>
                  <tr>
                    {block.headers.map((header, headerIndex) => (
                      <th key={`${header}-${headerIndex}`}>
                        {parseInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, rowIndex) => (
                    <tr key={`${row.join("-")}-${rowIndex}`}>
                      {block.headers.map((_, cellIndex) => (
                        <td key={`${rowIndex}-${cellIndex}`}>
                          {parseInlineMarkdown(row[cellIndex] || "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        if (block.type === "code") {
          return (
            <pre className="ai-advisor-md-code" key={`${block.type}-${blockIndex}`}>
              {block.language && (
                <span className="ai-advisor-md-code-label">{block.language}</span>
              )}
              <code>{block.text}</code>
            </pre>
          );
        }

        const fallbackTable = pipeParagraphToTable(block.text);

        if (fallbackTable) {
          return (
            <div className="ai-advisor-md-table-wrap" key={`${block.type}-${blockIndex}`}>
              <table className="ai-advisor-md-table">
                <thead>
                  <tr>
                    {fallbackTable.headers.map((header, headerIndex) => (
                      <th key={`${header}-${headerIndex}`}>
                        {parseInlineMarkdown(header)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fallbackTable.rows.map((row, rowIndex) => (
                    <tr key={`${row.join("-")}-${rowIndex}`}>
                      {fallbackTable.headers.map((_, cellIndex) => (
                        <td key={`${rowIndex}-${cellIndex}`}>
                          {parseInlineMarkdown(row[cellIndex] || "")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }

        return (
          <p className="ai-advisor-message-block" key={`${block.type}-${blockIndex}`}>
            {block.text.split("\n").map((line, lineIndex) => (
              <React.Fragment key={`${line}-${lineIndex}`}>
                {parseInlineMarkdown(line)}
                {lineIndex < block.text.split("\n").length - 1 && <br />}
              </React.Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function parseSseBlock(block) {
  const lines = block.split("\n");
  let event = "message";
  let data = "";

  lines.forEach((line) => {
    if (line.startsWith("event:")) {
      event = line.replace("event:", "").trim();
    }
    if (line.startsWith("data:")) {
      data += line.replace("data:", "").trim();
    }
  });

  if (!data) {
    return { event, data: {} };
  }

  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data: { content: data } };
  }
}

function AIAdvisor() {
  const { activeAsset } = useAsset();
  const [viewState, setViewState] = useState("closed");
  const [draft, setDraft] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [sentiment, setSentiment] = useState(null);
  const [activeTab, setActiveTab] = useState("chat");
  const [newsItems, setNewsItems] = useState([]);
  const [newsLoading, setNewsLoading] = useState(false);
  const [newsError, setNewsError] = useState("");
  const [messages, setMessages] = useState([
    makeMessage("assistant", DISPLAY_INITIAL_MESSAGE),
  ]);
  const messagesEndRef = useRef(null);
  const abortRef = useRef(null);

  const assetLabel = activeAsset?.name || "Crypto Market";
  const isOpen = viewState !== "closed";
  const isMaximized = viewState === "maximized";

  const assetStats = useMemo(
    () =>
      [
        { label: "Price", value: formatCurrency(activeAsset?.current_price) },
        {
          label: "24h",
          value: formatPercent(activeAsset?.price_change_percentage_24h),
        },
        { label: "Market Cap", value: formatCurrency(activeAsset?.market_cap) },
        { label: "Volume", value: formatCurrency(activeAsset?.total_volume) },
      ].filter((item) => item.value),
    [activeAsset]
  );

  const quickPrompts = useMemo(() => {
    if (activeAsset?.mode === "compare") {
      return [
        "Compare these assets",
        "Which risks differ most?",
        "Summarize the trend",
      ];
    }

    if (activeAsset?.mode === "watchlist") {
      return [
        "Summarize my watchlist",
        "Which asset looks weakest?",
        "What should I monitor?",
      ];
    }

    if (activeAsset?.mode === "asset") {
      return [
        "What's driving this today?",
        "Give me a quick history",
        "What risks stand out?",
      ];
    }

    return [
      "Summarize the market",
      "What looks bullish?",
      "What risks stand out?",
    ];
  }, [activeAsset]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  useEffect(() => {
    if (!isOpen) return;

    const params = new URLSearchParams();
    if (activeAsset?.id) params.set("asset_id", activeAsset.id);
    if (activeAsset?.name) params.set("asset_name", activeAsset.name);

    fetch(`${API_BASE_URL}/api/advisor/sentiment?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error("Sentiment request failed");
        return response.json();
      })
      .then(setSentiment)
      .catch(() =>
        setSentiment({
          label: "Offline",
          score: 0,
          basis: "Advisor backend is not reachable.",
        })
      );
  }, [activeAsset?.id, activeAsset?.name, isOpen]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (!isMaximized || activeTab !== "news") return;

    const params = new URLSearchParams();
    params.set("limit", "12");
    if (activeAsset?.name && activeAsset.name !== "Crypto Market") {
      params.set("asset_name", activeAsset.name);
    }
    if (activeAsset?.symbol) {
      params.set("asset_symbol", activeAsset.symbol);
    }

    setNewsLoading(true);
    setNewsError("");

    fetch(`${API_BASE_URL}/api/news/crypto?${params.toString()}`)
      .then((response) => {
        if (!response.ok) throw new Error("News request failed");
        return response.json();
      })
      .then((data) => setNewsItems(data.items || []))
      .catch(() => {
        setNewsError("Could not load hot crypto news right now.");
        setNewsItems([]);
      })
      .finally(() => setNewsLoading(false));
  }, [activeAsset?.name, activeAsset?.symbol, activeTab, isMaximized]);

  const resetConversation = () => {
    abortRef.current?.abort();
    setIsStreaming(false);
    setDraft("");
    setActiveTab("chat");
    setMessages([makeMessage("assistant", DISPLAY_INITIAL_MESSAGE)]);
  };

  const updateAssistantMessage = (id, contentChunk) => {
    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === id
          ? { ...message, content: `${message.content}${contentChunk}` }
          : message
      )
    );
  };

  const replaceAssistantMessage = (id, content) => {
    setMessages((currentMessages) =>
      currentMessages.map((message) =>
        message.id === id ? { ...message, content } : message
      )
    );
  };

  const sendMessage = async (text) => {
    const question = text.trim();
    if (!question || isStreaming) return;

    setActiveTab("chat");
    const userMessage = makeMessage("user", question);
    const assistantMessage = makeMessage("assistant", "");
    const recentMessages = messages
      .filter((message) => message.content.trim())
      .slice(-8)
      .map(({ role, content }) => ({ role, content }));

    setDraft("");
    setMessages((currentMessages) => [
      ...currentMessages,
      userMessage,
      assistantMessage,
    ]);
    setIsStreaming(true);

    abortRef.current?.abort();
    abortRef.current = new AbortController();

    try {
      const response = await fetch(`${API_BASE_URL}/api/advisor/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          asset: activeAsset,
          messages: recentMessages,
        }),
        signal: abortRef.current.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error("Advisor backend is not reachable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() || "";

        blocks.forEach((block) => {
          const { event, data } = parseSseBlock(block);

          if (event === "token" && data.content) {
            updateAssistantMessage(assistantMessage.id, data.content);
          }

          if (event === "error") {
            replaceAssistantMessage(
              assistantMessage.id,
              data.message || "The advisor had trouble answering."
            );
          }

          if (event === "meta" && data.sentiment) {
            setSentiment(data.sentiment);
          }
        });
      }
    } catch (error) {
      if (error.name !== "AbortError") {
        replaceAssistantMessage(
          assistantMessage.id,
          "I could not reach the AI Advisor backend. Start FastAPI on port 8000 and make sure backend/.env has GROQ_API_KEY."
        );
      }
    } finally {
      setIsStreaming(false);
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    sendMessage(draft);
  };

  const sentimentScore = sentiment?.score ?? 0;
  const sentimentPercent = Math.round(
    Math.max(0, Math.min(100, (sentimentScore + 1) * 50))
  );

  const chatPane = (
    <>
      <div
        className={`ai-advisor-messages ${
          isMaximized ? "ai-advisor-messages-spacious" : ""
        }`}
      >
        {messages.map((message) => (
          <div
            className={`ai-advisor-message ai-advisor-message-${message.role}`}
            key={message.id}
          >
            <MessageContent content={message.content} />
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="ai-advisor-prompts">
        {quickPrompts.map((prompt) => (
          <button
            type="button"
            key={prompt}
            onClick={() => sendMessage(prompt)}
            disabled={isStreaming}
          >
            {prompt}
          </button>
        ))}
      </div>

      <form className="ai-advisor-input" onSubmit={handleSubmit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={`Ask about ${assetLabel}`}
          disabled={isStreaming}
        />
        <button
          type="submit"
          disabled={!draft.trim() || isStreaming}
          aria-label="Send message"
        >
          <SendRoundedIcon />
        </button>
      </form>
    </>
  );

  const sentimentPane = (
    <div className="ai-advisor-tab-panel">
      <div className="ai-advisor-gauge-card">
        <span className="ai-advisor-pane-label">Live Sentiment</span>
        <strong>{sentiment?.label || "Checking"}</strong>
        <div className="ai-advisor-large-meter" aria-hidden="true">
          <span style={{ width: `${sentimentPercent}%` }} />
        </div>
        <p>
          {sentiment?.basis ||
            "The advisor blends visible dashboard context with live CoinGecko data when available."}
        </p>
      </div>

      <div className="ai-advisor-stat-grid">
        {assetStats.length > 0 ? (
          assetStats.map((stat) => (
            <div className="ai-advisor-stat" key={stat.label}>
              <span>{stat.label}</span>
              <strong>{stat.value}</strong>
            </div>
          ))
        ) : (
          <div className="ai-advisor-empty-state">
            Open a specific asset to see richer market statistics here.
          </div>
        )}
      </div>
    </div>
  );

  const newsPane = (
    <div className="ai-advisor-tab-panel">
      <div className="ai-advisor-news-header">
        <span className="ai-advisor-pane-label">Hot Crypto News</span>
        <p>
          Latest crypto headlines from trusted publishers. Open any card to read
          the original article.
        </p>
      </div>

      {newsLoading ? (
        <div className="ai-advisor-empty-state">Loading hot crypto news...</div>
      ) : newsError ? (
        <div className="ai-advisor-empty-state">{newsError}</div>
      ) : newsItems.length > 0 ? (
        <div className="ai-advisor-news-list">
          {newsItems.map((item) => (
            <a
              className="ai-advisor-news-card"
              href={item.url}
              key={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <div>
                <span className="ai-advisor-news-source">{item.source}</span>
                <h3>{item.title}</h3>
                {item.summary && <p>{item.summary}</p>}
              </div>
              <OpenInNewRoundedIcon />
            </a>
          ))}
        </div>
      ) : (
        <div className="ai-advisor-empty-state">No hot crypto news found.</div>
      )}
    </div>
  );

  const maximizedPane =
    activeTab === "sentiment"
      ? sentimentPane
      : activeTab === "news"
      ? newsPane
      : chatPane;

  return (
    <>
      <AnimatePresence>
        {viewState === "closed" && (
          <motion.button
            layoutId="ai-advisor-surface"
            className="ai-advisor-fab"
            type="button"
            onClick={() => setViewState("compact")}
            aria-label="Open AI Advisor"
            initial={{ opacity: 0, scale: 0.82 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.82 }}
            transition={SPRING_TRANSITION}
            whileHover={{ scale: 1.05 }}
            whileTap={{ scale: 0.96 }}
          >
            <AutoAwesomeRoundedIcon />
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isMaximized && (
          <motion.div
            className="ai-advisor-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setViewState("compact")}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            layout
            layoutId="ai-advisor-surface"
            className={`ai-advisor-panel ai-advisor-panel-${viewState}`}
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 24, scale: 0.96 }}
            transition={SPRING_TRANSITION}
            role="dialog"
            aria-label="AI Advisor chat"
          >
            {isMaximized && <span className="ai-advisor-drag-handle" />}

            <div className="ai-advisor-header">
              <div className="ai-advisor-title-group">
                <span className="ai-advisor-orb">
                  <AutoAwesomeRoundedIcon />
                </span>
                <div>
                  <span className="ai-advisor-kicker">AI Crypto Advisor</span>
                  <div className="ai-advisor-title-row">
                    <h2>{assetLabel}</h2>
                    <span
                      className={`ai-advisor-sentiment-chip ${sentimentClass(
                        sentimentScore
                      )}`}
                    >
                      {sentiment?.label || "Checking"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="ai-advisor-actions">
                <button
                  className="ai-advisor-icon-btn"
                  type="button"
                  onClick={() =>
                    setViewState(isMaximized ? "compact" : "maximized")
                  }
                  aria-label={isMaximized ? "Compact AI Advisor" : "Maximize AI Advisor"}
                  title={isMaximized ? "Compact" : "Maximize"}
                >
                  {isMaximized ? (
                    <CloseFullscreenRoundedIcon />
                  ) : (
                    <OpenInFullRoundedIcon />
                  )}
                </button>
                <button
                  className="ai-advisor-icon-btn"
                  type="button"
                  onClick={resetConversation}
                  aria-label="Reset conversation"
                  title="Refresh"
                >
                  <RefreshRoundedIcon />
                </button>
                <button
                  className="ai-advisor-icon-btn"
                  type="button"
                  onClick={() => setViewState(isMaximized ? "compact" : "closed")}
                  aria-label={isMaximized ? "Minimize AI Advisor" : "Close AI Advisor"}
                  title={isMaximized ? "Minimize" : "Close"}
                >
                  <CloseRoundedIcon />
                </button>
              </div>
            </div>

            <div
              className={`ai-advisor-body ${
                isMaximized ? "ai-advisor-body-maximized" : ""
              }`}
            >
              {isMaximized ? maximizedPane : chatPane}
            </div>

            {isMaximized && (
              <div className="ai-advisor-tabbar" role="tablist">
                {ADVISOR_TABS.map(({ id, label, Icon }) => (
                  <button
                    className={`ai-advisor-tab ${
                      activeTab === id ? "ai-advisor-tab-active" : ""
                    }`}
                    type="button"
                    role="tab"
                    aria-selected={activeTab === id}
                    key={id}
                    onClick={() => setActiveTab(id)}
                  >
                    {activeTab === id && (
                      <motion.span
                        className="ai-advisor-tab-indicator"
                        layoutId="ai-advisor-tab-indicator"
                        transition={SPRING_TRANSITION}
                      />
                    )}
                    <Icon />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

export default AIAdvisor;
