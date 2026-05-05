import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./globals.css";
import {
  createBrowserRouter,
  RouterProvider,
} from "react-router-dom";
import HomePage from "./pages/HomePage.jsx";
import SoloPage from "./pages/SoloPage.jsx";
import LobbyPage from "./pages/LobbyPage.jsx";
import PlayPage from "./pages/PlayPage.jsx";

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/p/:gameId", element: <SoloPage /> },
  { path: "/g/:gameId", element: <LobbyPage /> },
  { path: "/g/:gameId/play", element: <PlayPage /> },
]);

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
