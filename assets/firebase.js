// Firebase SDK 统一初始化（所有页面共用）
import { initializeApp } from "firebase/app";
import { getAuth, setPersistence, browserLocalPersistence } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const cfg = window.FIREBASE_CONFIG || {};

/** 是否已填入真实配置（未配置时页面给出提示） */
export const configured = !!(cfg.apiKey && !/^YOUR_/.test(cfg.apiKey));

export const app = initializeApp(cfg);
export const auth = getAuth(app);
export const db = getFirestore(app);

// 登录态本地保留，刷新不掉线
setPersistence(auth, browserLocalPersistence).catch(() => {});
