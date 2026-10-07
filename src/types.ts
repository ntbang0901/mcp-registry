export type ParamType = 'string' | 'number' | 'boolean' | 'secret';
export type ParamValue = string | number | boolean;

export interface ParamSpec {
  type: ParamType;
  description?: string;
  required?: boolean;
  default?: ParamValue;
}

export interface PackageSpec {
  registry: 'npm' | 'pypi';
  name: string;
  version: string;
}

export interface StdioTransportDef {
  type: 'stdio';
  package?: PackageSpec;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpTransportDef {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export interface ServerDef {
  name: string;
  description?: string;
  owner?: string;
  tags?: string[];
  status?: 'experimental' | 'stable' | 'deprecated';
  transport: StdioTransportDef | HttpTransportDef;
  params?: Record<string, ParamSpec>;
}

/** One server attached to one repository, with that repository's parameter values. */
export interface Binding {
  server: string;
  params: Record<string, ParamValue>;
}

export interface RepoContext {
  /** Normalized id: host/owner/name */
  id: string;
  /** Absolute path of the working tree root */
  root: string;
  host: string;
  /** Path part of the id, e.g. owner/name */
  slug: string;
  owner: string;
  name: string;
}

// ---- Intermediate representation (client-agnostic) ----

export type Part = { kind: 'text'; value: string } | { kind: 'env'; name: string };
/** A rendered string; `env` parts are secrets the client must read from the environment. */
export type Value = Part[];

export type ResolvedTransport =
  | { type: 'stdio'; command: Value; args: Value[]; env: Array<[string, Value]> }
  | { type: 'http'; url: Value; headers: Array<[string, Value]> };

export interface ResolvedServer {
  name: string;
  transport: ResolvedTransport;
}
