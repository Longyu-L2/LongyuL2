/**
 * The network a build is for: NETWORK=testnet|mainnet in build.mjs picks one of the profiles in
 * networks.json and fixes it into every page. Only that profile reaches the pages: under a build the
 * testnet fallback below is dead code and is left out. Under Node (the tests, and the repository's
 * own checks) nothing is built in and the testnet's profile is used, unless a test runner sets
 * __NETWORK__ and __PROFILE__ first (test/mainnet.mjs).
 */
import { defineChain, type Chain } from "viem";
import networks from "./networks.json" with { type: "json" };

export interface Profile {
  network: "testnet" | "mainnet";
  /** BNB Smart Chain, where LONGYU settles. */
  l1: {
    id: number;
    /** As a wallet and the pages name it: "BSC Testnet". */
    name: string;
    /** As running text names it: "BSC testnet". */
    short: string;
    explorer: string;
    /** The public node the pages read when L1_RPC_URL is not set. */
    rpc: string;
    /** viem's definition of the chain (viem/chains), as JSON. */
    chain: Chain;
  };
  /** LONGYU; `chain` holds the viem chain fields that differ by network (the testnet flag). */
  l2: { id: number; name: string; chain: { testnet?: boolean } };
  /** The native token's symbol on both chains. */
  native: string;
  /** The mined token. */
  token: { name: string; symbol: string };
  /** The bridge moves the mined token; otherwise it moves BNB only (LONG moves after the TGE). */
  bridgeToken: boolean;
  /** The swap page is built. */
  swap: boolean;
}

declare const __NETWORK__: Profile["network"];
declare const __PROFILE__: Profile;

export const PROFILE: Profile = typeof __NETWORK__ === "undefined" ? (networks.testnet as Profile) : __PROFILE__;

/** BNB Smart Chain as viem defines it. */
export const L1_CHAIN: Chain = /* @__PURE__ */ defineChain(PROFILE.l1.chain);
