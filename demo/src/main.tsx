import React from "react";
import ReactDOM from "react-dom/client";

import { App, installDemoBrowserHooks } from "./App";
import "../../cli/studio-app/src/styles.css";
import "./styles.css";

installDemoBrowserHooks();

const root = document.getElementById("root");

if (!root) {
  throw new Error("riptide demo: missing #root mount node");
}

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
