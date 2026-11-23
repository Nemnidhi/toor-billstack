import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import AppProviders from "./app/AppProviders";
import { router } from "./router";
import { refreshAccessToken } from "./api/axios";
import { restoreSession } from "./store/authStore";
import "./index.css";

// The access token is kept in memory only; get a fresh one from the refresh cookie before the
// route guards decide whether someone is signed in.
restoreSession(refreshAccessToken).finally(() => {
  ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
      <AppProviders>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </AppProviders>
    </React.StrictMode>
  );
});
