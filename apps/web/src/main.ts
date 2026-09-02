import { createElement } from "react";
import { createRoot } from "react-dom/client";
import NativeApp from "./native-app/NativeApp";
import "./styles/app.css";

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("native_app_root_missing");

createRoot(rootElement).render(createElement(NativeApp));
