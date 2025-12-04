// Global store for application-wide variables

interface GlobalStore {
  accessToken: string | null; // TrueData API access token
  dhanAccessToken: string | null; // DhanHQ API access token
}

// Initialize the global store with default values
export const globalStore: GlobalStore = {
  accessToken: null,
  dhanAccessToken: null,
};

/**
 * Updates the TrueData access token in the global store
 * @param token The new access token
 */
export const setAccessToken = (token: string): void => {
  globalStore.accessToken = token;
};

/**
 * Retrieves the current TrueData access token from the global store
 * @returns The current access token or null if not set
 */
export const getAccessToken = (): string | null => {
  return globalStore.accessToken;
};

/**
 * Updates the DhanHQ access token in the global store
 * @param token The new Dhan access token
 */
export const setDhanAccessToken = (token: string): void => {
  globalStore.dhanAccessToken = token;
};

/**
 * Retrieves the current DhanHQ access token from the global store
 * @returns The current Dhan access token or null if not set
 */
export const getDhanAccessToken = (): string | null => {
  return globalStore.dhanAccessToken;
};