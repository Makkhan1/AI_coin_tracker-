import React, { createContext, useCallback, useContext, useMemo, useState } from "react";

const defaultAsset = {
  id: "market",
  name: "Crypto Market",
  mode: "market",
};

const AssetContext = createContext({
  activeAsset: defaultAsset,
  setActiveAsset: () => {},
  resetActiveAsset: () => {},
});

export function AssetProvider({ children }) {
  const [activeAsset, setActiveAssetState] = useState(defaultAsset);

  const setActiveAsset = useCallback((asset) => {
    setActiveAssetState({
      ...defaultAsset,
      ...asset,
    });
  }, []);

  const resetActiveAsset = useCallback(() => {
    setActiveAssetState(defaultAsset);
  }, []);

  const value = useMemo(
    () => ({
      activeAsset,
      setActiveAsset,
      resetActiveAsset,
    }),
    [activeAsset, resetActiveAsset, setActiveAsset]
  );

  return <AssetContext.Provider value={value}>{children}</AssetContext.Provider>;
}

export function useAsset() {
  return useContext(AssetContext);
}
