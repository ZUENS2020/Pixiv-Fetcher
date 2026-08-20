import type { BrowserWorker } from "@cloudflare/puppeteer";

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  BUCKET: R2Bucket;
  COOKIE_ENC_KEY: string;
  MYBROWSER?: BrowserWorker;
  PIXIV_RELAY_URL?: string;
  PIXIV_RELAY_SECRET?: string;
}

export type SessPayload = {
  phpSessId: string;
  cookieHeader?: string;
  userAgent?: string;
  userId: string;
  userName: string;
  boundAt: number;
};
