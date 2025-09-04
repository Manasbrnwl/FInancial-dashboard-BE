// Global store for application-wide variables

interface GlobalStore {
  accessToken: string | null;
}

// Initialize the global store with default values
export const globalStore: GlobalStore = {
  accessToken: null,
};

/**
 * Updates the access token in the global store
 * @param token The new access token
 */
export const setAccessToken = (token: string): void => {
  globalStore.accessToken = token;
};

/**
 * Retrieves the current access token from the global store
 * @returns The current access token or null if not set
 */
export const getAccessToken = (): string | null => {
  return globalStore.accessToken;
};