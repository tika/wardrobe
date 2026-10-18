import * as Alchemy from "alchemy";
import * as Output from "alchemy/Output";
import * as Cloudflare from "alchemy/Cloudflare";
import * as State from "alchemy/State";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const isProd = process.env.ALCHEMY_STAGE === "prod";
/** Set by `alchemy dev`, which runs everything locally; Access is stubbed there instead of created. */
const isDev = ["true", "1", "yes", "on"].includes(process.env.ALCHEMY_DEV ?? "");
const ownerEmail = process.env.WARDROBE_OWNER_EMAIL;
if (!ownerEmail) throw new Error("Set WARDROBE_OWNER_EMAIL in .env: the one Google account Cloudflare Access lets in.");

/** Every image: import working files, library cutouts and modeled photos, and the model reference. */
export const Storage = Cloudflare.R2.Bucket("Storage");

/** Wardrobe items and import jobs. Migrations come from `bun run db:generate` (src/db/schema.ts). */
export const Database = Cloudflare.D1.Database("Database", { migrations: "./migrations" });

/** Durable image generation for one import-job stage; implemented by `GenerateStage` in src/index.ts. */
export const Generate = Cloudflare.Workflow("GenerateStage", { className: "GenerateStage" });

/** Lets the iOS app and the agent CLIs through Access without a browser login. */
export const AppToken = Cloudflare.Access.ServiceToken("AppToken", { name: "wardrobe-app", duration: "8760h" });

/** Sign-in for the web app: your Google account (an OAuth client from Google Cloud, in .env). */
export const GoogleLogin = Cloudflare.Access.IdentityProvider("GoogleLogin", {
  name: "Google",
  type: "google",
  config: {
    clientId: Config.String("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: Config.String("GOOGLE_OAUTH_CLIENT_SECRET"),
    pkceEnabled: true,
  },
});

/** Access policies: you, signed in with Google, and the app's service token. */
export const OwnerPolicy = Cloudflare.Access.Policy("OwnerPolicy", Effect.gen(function* () {
  const google = yield* GoogleLogin;
  return { decision: "allow", include: [{ email: ownerEmail }], require: [{ loginMethod: google.identityProviderId }] };
}));
export const AppTokenPolicy = Cloudflare.Access.Policy("AppTokenPolicy", Effect.gen(function* () {
  const token = yield* AppToken;
  return { decision: "non_identity", include: [{ serviceToken: token.serviceTokenId }] };
}));

/** The API and the web app (built to apps/web/dist), behind Cloudflare Access. */
export const Api = Cloudflare.Worker("Api", Effect.gen(function* () {
  // Only these two policies get past Access, on every URL the Worker has (domain, workers.dev, previews).
  const access = isDev ? undefined : {
    sessionDuration: "720h",
    // Straight to Google's sign-in; no Cloudflare picker or emailed codes.
    allowedIdps: [(yield* GoogleLogin).identityProviderId],
    autoRedirectToIdentity: true,
    policies: [{ policyId: (yield* OwnerPolicy).policyId }, { policyId: (yield* AppTokenPolicy).policyId }],
  };
  return {
    main: "./src/index.ts",
    assets: {
      directory: "../web/dist",
      notFoundHandling: "single-page-application" as const,
      runWorkerFirst: ["/api/*"],
    },
    access,
    ...(isProd ? { domain: { name: "wardrobe.capon.io" } } : {}),
    dev: { port: 4747, ...(isDev ? { access: { identity: { email: ownerEmail } } } : {}) },
    env: {
      BUCKET: Storage,
      DB: Database,
      GENERATE: Generate,
      GEMINI_API_KEY: Config.Redacted("GEMINI_API_KEY"),
      GEMINI_IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image",
      GEMINI_VISION_MODEL: process.env.GEMINI_VISION_MODEL ?? "gemini-3.8-flash",
    },
  };
}));

export default Alchemy.Stack(
  "Wardrobe",
  {
    providers: Cloudflare.providers(),
    // Prod state lives in Cloudflare so CI and laptops share it; personal stages keep theirs under .alchemy/.
    state: isProd ? Cloudflare.state() : State.localState(),
  },
  Effect.gen(function* () {
    const api = yield* Api;
    if (isDev) return { url: api.url };
    const token = yield* AppToken;
    return {
      url: api.url,
      accessClientId: token.clientId,
      // Shown only on a laptop deploy, never in CI logs. Copy it into .env as CF_ACCESS_CLIENT_SECRET.
      ...(!process.env.CI ? { accessClientSecret: Output.map(token.clientSecret, (secret) => secret && Redacted.value(secret)) } : {}),
    };
  }),
);
