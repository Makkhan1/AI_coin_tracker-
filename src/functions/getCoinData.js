import axios from "axios";
import { API_BASE_URL } from "./apiConfig";

export const getCoinData = (id, setError) => {
  const coin = axios
    .get(`${API_BASE_URL}/api/coins/${id}`)
    .then((response) => {
      if (response.data) {
        return response.data;
      }
    })
    .catch((e) => {
      console.log(e.message);
      if (setError) {
        setError(true);
      }
    });

  return coin;
};
