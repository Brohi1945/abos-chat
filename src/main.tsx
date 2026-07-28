import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { GlobalErrorCatcher } from "./components/DebugErrorBoundary"; // TEMPORARY — remove once quick-wins bug is found
import { initSentry } from "./lib/sentry";
import "./theme/tokens.css";
import "./index.css";

initSentry();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <GlobalErrorCatcher>
      <App />
    </GlobalErrorCatcher>
  </React.StrictMode>
);

