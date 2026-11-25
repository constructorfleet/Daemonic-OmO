import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { AppRouter } from "./router"
import "./styles/tokens.css"
import "./styles/app-shell.css"
import "./styles/page-content.css"

if (import.meta.env.DEV) {
  void import("react-grab")
  void import("react-scan")
}

const root = document.getElementById("root")

if (root === null) {
  throw new Error("The application root element is missing.")
}

createRoot(root).render(
  <StrictMode>
    <AppRouter />
  </StrictMode>,
)
