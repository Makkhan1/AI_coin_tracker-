import React, { useEffect, useState } from "react";
import Button from "../components/Common/Button";
import Header from "../components/Common/Header";
import TabsComponent from "../components/Dashboard/Tabs";
import { useAsset } from "../context/AssetContext";
import { get100Coins } from "../functions/get100Coins";

function Watchlist() {
  const watchlist = JSON.parse(localStorage.getItem("watchlist"));
  const [coins, setCoins] = useState([]);
  const { setActiveAsset } = useAsset();

  useEffect(() => {
    setActiveAsset({
      id: "watchlist",
      name: "Watchlist",
      mode: "watchlist",
      watchlistAssets: [],
    });

    if (watchlist) {
      getData();
    }
  }, []);

  const getData = async () => {
    const allCoins = await get100Coins();
    if (allCoins) {
      const savedCoins = allCoins.filter((coin) => watchlist.includes(coin.id));
      setCoins(savedCoins);
      setActiveAsset({
        id: "watchlist",
        name: "Watchlist",
        mode: "watchlist",
        watchlistAssets: savedCoins.slice(0, 10).map((coin) => ({
          id: coin.id,
          name: coin.name,
          symbol: coin.symbol,
          current_price: coin.current_price,
          price_change_percentage_24h: coin.price_change_percentage_24h,
          market_cap: coin.market_cap,
          total_volume: coin.total_volume,
        })),
      });
    }
  };

  return (
    <div>
      <Header />
      {watchlist?.length > 0 ? (
        <TabsComponent coins={coins} />
      ) : (
        <div>
          <h1 style={{ textAlign: "center" }}>
            Sorry, No Items In The Watchlist.
          </h1>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              margin: "2rem",
            }}
          >
            <a href="/dashboard">
              <Button text="Dashboard" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

export default Watchlist;
