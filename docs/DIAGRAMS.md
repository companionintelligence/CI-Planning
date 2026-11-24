# Companion Planning — Current System Flows

Updated 2026-11-23 from `client/src`, `server/src`, `server/src/db/schema.ts`, and the migration registry. Solid paths are implemented. Dashed paths are optional, conditional, or proposed follow-up work.

## System flow

```mermaid
flowchart LR
  subgraph Clients["Browser and native shells"]
    Web["SolidJS web app"]
    Mobile["Capacitor iOS / Android"]
    Desktop["Tauri desktop shell"]
  end
  subgraph Server["Companion Planning server"]
    Static["Koa static client"]
    API["Koa REST API"]
    GQL["Apollo GraphQL API"]
    SSE["SSE event stream"]
    Jobs["Croner jobs"]
    Services["Services and domain engines"]
    Agents["LLM-backed agents"]
    Store["Store facade"]
  end
  SQLite[("SQLite / WAL — default")]
  Postgres[("PostgreSQL — alternate backend")]
  LLM["Configured LLM provider<br/>Ollama / remote compatible"]
  Google["Google APIs<br/>Gmail and Calendar connectors"]

  Web --> Static
  Mobile --> Static
  Desktop --> Static
  Web <--> API
  Mobile <--> API
  Desktop <--> API
  Web -. "live updates" .-> SSE
  Mobile -. "live updates" .-> SSE
  Desktop -. "live updates" .-> SSE
  API --> Services
  GQL --> Services
  Jobs --> Agents
  Jobs --> Services
  Services --> Agents
  Agents <--> LLM
  Agents <--> Google
  Services --> Store
  Store --> SQLite
  Store -. "configured backend" .-> Postgres

  classDef built fill:#eaf3ff,stroke:#2b6cb0,color:#13315c;
  classDef optional fill:#fff7e6,stroke:#c08a1e,color:#6d4d00,stroke-dasharray:5 4;
  class Web,Mobile,Desktop,Static,API,GQL,SSE,Jobs,Services,Agents,Store,SQLite built;
  class Postgres,LLM,Google optional;
```

## User flow

```mermaid
flowchart TD
  SignIn["Sign in / local auth"] --> Today["Today cockpit"]
  Today --> Focus["Focus: choose day, priorities, habits, note"]
  Today --> Tasks["Tasks: search, add, edit, complete, notes"]
  Today --> Planner["Planner: stage tasks and schedule"]
  Tasks --> Objectives["Objectives: group goals and tasks"]
  Planner --> Plan["Review Flight Plan selection"]
  Plan --> Schedule["Schedule selected tasks"]
  Schedule --> Review["Inspect blocks, adjust time, lock or move"]
  Review --> Complete["Work, complete, reflect"]
  Complete --> Metrics["Balance / Metrics recap"]
  Today --> Agent["Task assistant: ask about tasks, screen or metrics"]
  Agent --> Draft["Review proposed changes"]
  Draft -->|Confirm| Apply["Apply through existing APIs"]
  Draft -->|Edit| Clarify["Send follow-up clarification"]
  Draft -->|Forget| Today
  Apply --> Today
  Clarify --> Draft
```

## Data flow

```mermaid
flowchart LR
  UI["Views and components"] --> Stores["Solid resources and stores"]
  Stores --> ClientAPI["Typed API client"]
  ClientAPI --> Auth["Koa auth and owner scope"]
  Auth --> Routes["REST routes / GraphQL resolvers"]
  Routes --> Services["Services: validation, business rules"]
  Services --> Engines["Scheduling, recurrence, reflow, metrics"]
  Services --> DBFacade["Async Store facade"]
  Engines --> DBFacade
  DBFacade --> DB[("SQLite default / PostgreSQL adapter")]
  DB --> Serialize["DTO serialization"]
  Serialize --> Response["HTTP response"]
  Response --> Stores
  Services --> Events["SSE broadcasts"]
  Events --> Stores
  Stores --> UI
```

## Agent flow

```mermaid
sequenceDiagram
  actor User
  participant Chat as Task assistant UI
  participant Route as /api/task-agent/plan
  participant Scope as Owner-scoped context services
  participant Model as Configured LLM
  participant APIs as Existing task/objective APIs
  participant DB as Store
  User->>Chat: Type or dictate; review transcript
  Chat->>Route: Message, bounded history, screen summary
  Route->>Scope: Search task candidates / read objectives / screen context
  Scope->>DB: Owner-scoped reads
  DB-->>Scope: Candidate records and state
  Route->>Model: Request + bounded context
  Model-->>Route: Structured reply and proposed actions
  Route->>Route: Validate action kinds, IDs and fields
  Route-->>Chat: Reply + proposals (no writes)
  Chat-->>User: Confirm / edit / forget
  User->>Chat: Confirm
  Chat->>APIs: Apply accepted action(s)
  APIs->>DB: Validated writes, notes, placement
  DB-->>APIs: Updated records
  APIs-->>Chat: Success or partial failure
  Chat-->>User: Outcome
```

## Metric flow

```mermaid
flowchart LR
  TaskEvents["Task status, completion, cancellation"] --> TaskMetrics["taskMetrics(owner, days)"]
  TimeEntries["Timer and manual time entries"] --> TaskMetrics
  Rituals["Close ritual ratings"] --> TaskMetrics
  TaskMetrics --> MetricsAPI["GET /api/metrics/tasks"]
  TrialityEvents["Suggestion impressions, responses, outcomes"] --> TrialityMetrics["trialityMetrics(owner, days)"]
  TrialityMetrics --> TrialityAPI["GET /api/metrics/triality"]
  Calibration["Classification / plan-loop / placement evidence"] --> CalAPI["Calibration and learning endpoints"]
  DailyState["Daily completion snapshot"] --> Stars["daily_recap / computeStars"]
  MetricsAPI --> Balance["Balance → Metrics tab"]
  TrialityAPI --> Balance
  CalAPI --> Settings["Settings → learning metrics"]
  Stars --> Focus["Focus stars"]
  Stars --> Calendar["Calendar recap and heatmap"]
  Balance --> Agent["Task assistant metrics recap"]
```
