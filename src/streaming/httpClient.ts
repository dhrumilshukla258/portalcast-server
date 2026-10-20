import { setting } from "@/config/settings";
import axios, { AxiosInstance, AxiosError } from "axios";
import http from "http";
import https from "https";
import { onSettingChange } from "@/config/settings";
import { logger } from "@/infra/logger";

const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const httpClient: AxiosInstance = axios.create({
  httpAgent,
  httpsAgent,
  timeout: setting<number>("apiTimeoutMs"),

  validateStatus: (status) => status !== 429,
});

const MAX_RETRIES = () => setting<number>("apiRetries");
onSettingChange((key) => {
  if (key === "apiTimeoutMs") httpClient.defaults.timeout = setting<number>("apiTimeoutMs");
});
const RETRY_DELAY = 1000;

httpClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error: AxiosError) => {
    const config = error.config as any;

    const isAborted = error.message?.toLowerCase().includes("aborted") || 
                      error.code === "ERR_CANCELED";
    const isTimeout = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || error.message?.toLowerCase().includes("timeout");

    if (!config || config.responseType === "stream" || config.skipRetry || isAborted || isTimeout || config.__retryCount >= MAX_RETRIES()) {
      return Promise.reject(error);
    }

    const shouldRetry = error.response?.status === 429 || !error.response;

    if (shouldRetry) {
      config.__retryCount = (config.__retryCount || 0) + 1;

      let delay = RETRY_DELAY * Math.pow(2, config.__retryCount - 1);

      if (error.response?.status === 429) {
        delay = Math.floor(Math.random() * (30000 - 10000 + 1) + 10000);
      }

      const errorMessage = error.response
        ? `Status ${error.response.status}`
        : error.message;

      logger.warn(
        `[HttpClient] Request failed: ${errorMessage}. Retrying (${config.__retryCount}/${MAX_RETRIES()}) in ${delay}ms...`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));

      return httpClient(config);
    }

    return Promise.reject(error);
  },
);

export { httpClient };
