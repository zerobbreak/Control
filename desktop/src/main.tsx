import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";

// Both windows load this page; the window label picks which UI (and stylesheet) it gets.
const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);
const view = getCurrentWindow().label === "pill" ? import("./Pill") : import("./App");

view.then(({ default: View }) =>
  root.render(
    <React.StrictMode>
      <View />
    </React.StrictMode>,
  ),
);
