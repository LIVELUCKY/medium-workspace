import { initializeApp, getApps } from "firebase/app";
import { getAnalytics, logEvent, isSupported } from "firebase/analytics";

const firebaseConfig = {
  apiKey: "AIzaSyCVFGdhbCCJhMgl6OJ-c2GSHmZp6Xjz-bI",
  authDomain: "medium-workspace-tool.firebaseapp.com",
  projectId: "medium-workspace-tool",
  storageBucket: "medium-workspace-tool.firebasestorage.app",
  messagingSenderId: "1093471341948",
  appId: "1:1093471341948:web:5c87c2f3c75df17c3628f9",
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

const CONSENT_KEY = "analytics_consent";

export function getConsent(): "granted" | "denied" | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(CONSENT_KEY) as "granted" | "denied" | null;
}

export function setConsent(value: "granted" | "denied"): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(CONSENT_KEY, value);
}

// Analytics is never initialised until consent is "granted".
export async function track(event: string, params?: Record<string, string | number>) {
  if (typeof window === "undefined") return;
  if (getConsent() !== "granted") return;
  if (!process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID) return;
  if (!(await isSupported())) return;
  const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
  logEvent(getAnalytics(app), event, params);
}
