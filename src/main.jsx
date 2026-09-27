import { Component, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// If something unexpected breaks while showing an event (for example the locator's data
// changed shape), show a plain message instead of a blank page.
class Boundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="wrap">
        <section className="panel crash" role="alert">
          <h1 className="sec">Something went wrong showing this event</h1>
          <p className="muted">This can happen if the Riftbound event locator changed how it shares its data. Reloading usually helps; if it keeps happening, try again later.</p>
          <p className="muted small mono">{String(this.state.error?.message || this.state.error).slice(0, 200)}</p>
          <div className="crash-actions">
            <button type="button" className="primary" onClick={() => location.reload()}>Reload</button>
            <button type="button" className="link small" onClick={() => {
              // forget the event that broke, so the start page loads clean
              try { localStorage.removeItem("rb-last-event"); localStorage.removeItem("rb-last-event-info"); } catch { /* storage unavailable */ }
              location.href = location.pathname;
            }}>Start over</button>
          </div>
        </section>
      </div>
    );
  }
}

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <Boundary>
      <App />
    </Boundary>
  </StrictMode>
);
