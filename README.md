# AI Coin Tracker

React crypto dashboard with a floating Groq-powered AI Advisor.

## Local Setup With Conda

Open this folder in VS Code:

```powershell
cd C:\Users\admin\AI_coin_tracker-
code .
```

Create one Conda environment for both React and the Python backend:

```powershell
conda create -n coin-tracker-ai -c conda-forge python=3.11 nodejs=20
conda activate coin-tracker-ai
```

Install dependencies:

```powershell
npm ci
pip install -r backend/requirements.txt
```

Create the backend environment file:

```powershell
copy backend\.env.example backend\.env
```

Open `backend/.env` and set:

```text
GROQ_API_KEY=your_real_groq_api_key
```

If CoinGecko starts returning `429 Too Many Requests`, add a free/demo CoinGecko key too:

```text
COINGECKO_DEMO_API_KEY=your_coingecko_demo_key
```

The frontend API URL already defaults to `http://localhost:8000`. If you want to override it:

```powershell
copy .env.example .env
```

## Run Locally

Use two VS Code terminals.

Terminal 1, backend:

```powershell
conda activate coin-tracker-ai
uvicorn backend.main:app --reload --port 8000
```

Terminal 2, frontend:

```powershell
conda activate coin-tracker-ai
npm start
```

Open:

```text
http://localhost:3000
```

## APIs Used

- CoinGecko public API for market and coin data, proxied through FastAPI to avoid browser CORS issues.
- Groq Chat Completions API from the FastAPI backend.

Never put `GROQ_API_KEY` in React files or frontend `.env` files. Keep it only in `backend/.env`.
