import { parseLandingConfig } from "./landing-core.ts";
import { copyButtons, topBar, walletButton } from "./site.ts";

declare const __LANDING_CONFIG__: unknown;

topBar();
copyButtons();
walletButton(parseLandingConfig(__LANDING_CONFIG__));
