/**
 * The app's variant (app.config.ts), fixed into the bundle as EXPO_PUBLIC_APP_VARIANT by metro.config.js.
 * Production is the mainnet app; development and testnet builds run against the testnet.
 *
 * Text and addresses that only one variant may hold are chosen with the comparison itself,
 * `process.env.EXPO_PUBLIC_APP_VARIANT === "production"`, in the file that holds them, not with this
 * constant: a release build drops the other variant's side only when the comparison is in the same file.
 */
export const MAINNET = process.env.EXPO_PUBLIC_APP_VARIANT === "production";
