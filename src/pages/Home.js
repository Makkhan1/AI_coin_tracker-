import React, { useEffect } from "react";
import Header from "../components/Common/Header";
import MainComponent from "../components/LandingPage/MainComponent";
import { useAsset } from "../context/AssetContext";

function Home() {
  const { setActiveAsset } = useAsset();

  useEffect(() => {
    setActiveAsset({
      id: "market",
      name: "Crypto Market",
      mode: "market",
    });
  }, [setActiveAsset]);

  return (
    <>
      <Header />
      <MainComponent />
    </>
  );
}

export default Home;
