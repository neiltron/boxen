import { useState } from "react";
import { createRoot } from "react-dom/client";
import { emptySession, type AgentState, type ModelInfo } from "@boxen/client";
import { ModelPicker } from "../src/components/ModelPicker";

const models: ModelInfo[] = [
  { provider: "anthropic", id: "claude-test", name: "Claude test", thinkingLevels: ["off", "high"] },
  { provider: "openrouter", id: "vendor/model-test", name: "Router test", thinkingLevels: ["off"] },
  { provider: "github-copilot", id: "copilot-test", name: "Copilot test", thinkingLevels: ["low", "high"] },
  { provider: "openai", id: "openai-test", name: "OpenAI test", thinkingLevels: ["low", "high"] },
];
export function Fixture() {
  const [state, setState] = useState(() => ({
    ...emptySession(), ready: true, models,
    model: { ...emptySession().model, agent: { model: { provider: "anthropic", modelId: "claude-test" }, thinkingLevel: "high" } as AgentState },
  }));
  const [configured, setConfigured] = useState(0);
  const configure = (agent: AgentState) => {
    setConfigured((n) => n + 1);
    setState((s) => ({ ...s, model: { ...s.model, agent } }));
    return true;
  };
  return <>
    <ModelPicker session={{ ...state, configure, listModels: () => true, prompt: () => false, abort: () => false }} />
    <span aria-label="Session configuration count">{configured}</span>
    <button onClick={() => setState((s) => ({ ...s, ready: false }))}>Disconnect fixture</button>
    <button onClick={() => setState((s) => ({ ...s, model: { ...s.model, agent: {} } }))}>Clear fixture model</button>
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
