export interface SelectorConfig {
  id: string;
  description: string;
  primary: string;
  fallbacks: string[];
  context: string;
  aiHealed?: string;
  lastHealed?: string;
  confidence?: number;
}

export interface SelectorMap {
  version: string;
  workflow: string;
  lastUpdated: string;
  selectors: Record<string, SelectorConfig>;
}

export interface AIHealingResult {
  selector: string;
  confidence: number;
  reasoning: string;
}

export interface HealingAttempt {
  selectorId: string;
  originalSelector: string;
  newSelector: string;
  confidence: number;
  timestamp: string;
  success: boolean;
}
