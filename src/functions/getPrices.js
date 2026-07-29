import axios from "axios";
import { API_BASE_URL } from "./apiConfig";

export const getPrices = (id, days, priceType, setError) => {
  const prices = axios
    .get(
      `${API_BASE_URL}/api/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`
    )
    .then((response) => {
      if (response.data) {
        console.log("Prices>>>", response.data);
        if (priceType == "market_caps") {
          return response.data.market_caps;
        } else if (priceType == "total_volumes") {
          return response.data.total_volumes;
        } else {
          return response.data.prices;
        }
      }
    })
    .catch((e) => {
      console.log(e.message);
      if (setError) {
        setError(true);
      }
    });

  return prices;
};
