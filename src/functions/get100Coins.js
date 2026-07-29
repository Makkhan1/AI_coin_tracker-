import axios from "axios";
import { API_BASE_URL } from "./apiConfig";

export const get100Coins = () => {
  const coins = axios
    .get(
      `${API_BASE_URL}/api/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&sparkline=false`
    )
    .then((response) => {
      console.log("RESPONSE>>>", response.data);
      return response.data;
    })
    .catch((error) => {
      console.log("ERROR>>>", error.message);
    });

  return coins;
};
