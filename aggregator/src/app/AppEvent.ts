import { HTTPMethods } from "../../deps.ts";

type RowId = number | undefined;

type AppEvent = (
  | { type: "listening"; data: { port: number } }
  | { type: "db-query"; data: { sql: string; params: unknown[] } }
  | { type: "waiting-unconfirmed-space" }
  | {
    type: "submission-attempt";
    data: { publicKeyShorts: string[]; attemptNumber: number };
  }
  | {
    type: "submission-attempt-failed";
    data: {
      publicKeyShorts: string[];
      attemptNumber: number;
      error: Error;
    };
  }
  | { type: "submission-sent"; data: { rowIds: RowId[] } }
  | {
    type: "submission-confirmed";
    data: { rowIds: RowId[]; blockNumber: number };
  }
  | { type: "warning"; data: string }
  | {
    type: "bundle-added";
    data: {
      publicKeyShorts: string[];
    };
  }
  | {
    type: "error";
    data: string;
  }
  | {
    type: "request-start";
    data: {
      method: HTTPMethods;
      path: string;
    };
  }
  | {
    type: "request-end";
    data: {
      method: HTTPMethods;
      path: string;
      status: number;
      duration: number;
    };
  }
);

export default AppEvent;
