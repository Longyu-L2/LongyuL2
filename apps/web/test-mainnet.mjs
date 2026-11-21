// Loaded before src/mainnet.test.ts (npm test): the pages' code then sees the mainnet profile, as a
// NETWORK=mainnet build fixes it in (src/profile.ts).
import { profileFor } from "./build.mjs";

globalThis.__NETWORK__ = "mainnet";
globalThis.__PROFILE__ = profileFor("mainnet");
