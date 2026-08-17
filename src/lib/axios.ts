import axios, {
  AxiosError,
  InternalAxiosRequestConfig,
} from "axios";

import { env } from "@/config/env";
import { API_BASE_PATH } from "@/config/constants";
import { getOrCreateDeviceId } from "@/lib/utils";

const apiClient = axios.create({
  baseURL: env.FRAPPE_URL,
  withCredentials: true,
});

/*
|--------------------------------------------------------------------------
| CSRF TOKEN
|--------------------------------------------------------------------------
*/

let csrfToken: string | null = null;
let csrfInFlight: Promise<string | null> | null = null;

/*
|--------------------------------------------------------------------------
| Auth endpoints
|--------------------------------------------------------------------------
|
| These endpoints can run before a Frappe session exists.
|
*/

function isAuthEndpoint(url?: string) {
  if (!url) return false;

  return (
    url.includes(`${API_BASE_PATH}.login`) ||
    url.includes("/api/method/login")
  );
}

/*
|--------------------------------------------------------------------------
| Get CSRF token
|--------------------------------------------------------------------------
*/

async function requestCsrfToken(): Promise<string | null> {
  try {
    const response = await axios.get(
      `${env.FRAPPE_URL}${API_BASE_PATH}.csrf_token`,
      {
        withCredentials: true,
        headers: {
          Accept: "application/json",
        },
      },
    );

    const token = response.data?.message;

    if (typeof token === "string" && token.length > 0) {
      return token;
    }

    return null;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      // Guest sessions do not have a CSRF token. Login can proceed without one.
      if (error.response?.status !== 403) {
        console.error(
          "Failed to fetch Frappe CSRF token:",
          error.response?.status,
          error.response?.data,
        );
      }
    } else {
      console.error("Failed to fetch Frappe CSRF token:", error);
    }

    return null;
  }
}

/*
|--------------------------------------------------------------------------
| Deduplicate CSRF requests
|--------------------------------------------------------------------------
*/

function fetchCsrfToken(): Promise<string | null> {
  if (!csrfInFlight) {
    csrfInFlight = requestCsrfToken().finally(() => {
      csrfInFlight = null;
    });
  }

  return csrfInFlight;
}

/*
|--------------------------------------------------------------------------
| Public CSRF setter
|--------------------------------------------------------------------------
*/

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

/*
|--------------------------------------------------------------------------
| Detect write requests
|--------------------------------------------------------------------------
*/

function isWriteRequest(method?: string) {
  if (!method) return false;

  const normalized = method.toLowerCase();

  return (
    normalized === "post" ||
    normalized === "put" ||
    normalized === "delete" ||
    normalized === "patch"
  );
}

/*
|--------------------------------------------------------------------------
| Request interceptor
|--------------------------------------------------------------------------
*/

apiClient.interceptors.request.use(
  async (config: InternalAxiosRequestConfig) => {
    /*
    |--------------------------------------------------------------------------
    | Device ID
    |--------------------------------------------------------------------------
    */

    if (typeof window !== "undefined") {
      config.headers["X-Device-Id"] = getOrCreateDeviceId();
    }

    const method = config.method?.toLowerCase();
    const isWrite = isWriteRequest(method);
    const url = config.url || "";

    /*
    |--------------------------------------------------------------------------
    | CSRF
    |--------------------------------------------------------------------------
    */

    if (
      isWrite &&
      typeof window !== "undefined"
    ) {
      /*
      Only fetch CSRF if we don't already have one.
      */

      if (!csrfToken) {
        const freshToken = await fetchCsrfToken();

        if (freshToken) {
          csrfToken = freshToken;
        }
      }

      /*
      Add CSRF header when available.
      */

      if (csrfToken) {
        config.headers["X-Frappe-CSRF-Token"] = csrfToken;
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Frappe POST/PUT/DELETE payload handling
    |--------------------------------------------------------------------------
    |
    | Frappe whitelisted methods commonly receive form-encoded arguments.
    |
    */

    if (
      isWrite &&
      config.data &&
      typeof config.data === "object" &&
      !(config.data instanceof URLSearchParams) &&
      !(config.data instanceof FormData) &&
      !(config.data instanceof Blob)
    ) {
      const params = new URLSearchParams();

      Object.entries(config.data).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          return;
        }

        if (typeof value === "object") {
          params.append(key, JSON.stringify(value));
        } else {
          params.append(key, String(value));
        }
      });

      config.data = params;

      config.headers["Content-Type"] =
        "application/x-www-form-urlencoded";
    }

    return config;
  },
);

/*
|--------------------------------------------------------------------------
| Response interceptor
|--------------------------------------------------------------------------
*/

apiClient.interceptors.response.use(
  (response) => {
    /*
    Frappe responses usually look like:

    {
      message: {...}
    }

    Keep your existing behavior of unwrapping message.
    */

    if (
      response.data &&
      typeof response.data === "object" &&
      "message" in response.data
    ) {
      response.data = response.data.message;
    }

    return response;
  },

  async (error: AxiosError) => {
    if (!axios.isAxiosError(error)) {
      return Promise.reject(error);
    }

    const status = error.response?.status;
    const url = error.config?.url || "";
    const body = error.response?.data as any;

    /*
    |--------------------------------------------------------------------------
    | Extract Frappe error text
    |--------------------------------------------------------------------------
    */

    const serverText = JSON.stringify({
      exception: body?.exception,
      message: body?.message,
      exc_type: body?.exc_type,
    });

    /*
    |--------------------------------------------------------------------------
    | CSRF failure detection
    |--------------------------------------------------------------------------
    */

    const isCsrfFailure =
      (status === 400 || status === 403) &&
      /csrf|invalid request/i.test(serverText);

    const isMissingSession =
      status === 403 &&
      /login to access|not whitelisted/i.test(serverText);

    /*
    |--------------------------------------------------------------------------
    | Retry CSRF-protected request ONCE
    |--------------------------------------------------------------------------
    */

    if (
      isCsrfFailure &&
      error.config &&
      !(error.config as any).__csrfRetried
    ) {
      console.warn(
        "Frappe CSRF token expired/invalid. Refreshing token...",
      );

      /*
      Clear old token.
      */

      csrfToken = null;

      /*
      Get fresh token.
      */

      const freshToken = await fetchCsrfToken();

      if (freshToken) {
        csrfToken = freshToken;

        /*
        Clone request config.
        */

        const retryConfig = {
          ...error.config,
          __csrfRetried: true,
        } as InternalAxiosRequestConfig & {
          __csrfRetried?: boolean;
        };

        /*
        Preserve existing headers.
        */

        retryConfig.headers = {
          ...error.config.headers,
          "X-Frappe-CSRF-Token": freshToken,
        } as any;

        return apiClient.request(retryConfig);
      }
    }

    /*
    |--------------------------------------------------------------------------
    | Unauthorized
    |--------------------------------------------------------------------------
    */

    if (
      (status === 401 || isMissingSession) &&
      !isAuthEndpoint(url)
    ) {
      csrfToken = null;

      try {
        const { useAuthStore } = require("@/stores/authStore");

        useAuthStore.getState().clearAuth();
      } catch (storeError) {
        console.error(
          "Failed to clear auth store:",
          storeError,
        );
      }

      if (typeof window !== "undefined") {
        window.location.href = "/login";
      }
    }

    /*
    |--------------------------------------------------------------------------
    | CSRF 403 debugging
    |--------------------------------------------------------------------------
    */

    if (
      status === 403 &&
      !isAuthEndpoint(url)
    ) {
      console.error(
        "Frappe returned 403.",
        {
          url,
          response: body,
        },
      );
    }

    return Promise.reject(error);
  },
);

export default apiClient;
