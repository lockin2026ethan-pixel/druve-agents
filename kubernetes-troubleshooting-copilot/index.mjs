// Kubernetes Troubleshooting Copilot: a Druve agent ported by hand from the
// n8n template "Conversational Kubernetes Management with GPT-4o and MCP
// Integration" by Reza Gholizade (https://n8n.io/workflows/4023). Draft for
// Reza to check. Nothing is published.
//
// What it keeps, unchanged: the AI Agent's system message, including the
// Kubernetes and Helm tool lists and every usage rule. The current time is
// filled in (the template uses Asia/Tehran; the buyer can pass a timezone).
// What changes: a Druve agent runs on the buyer's machine with no route to a
// private cluster, so it cannot call the MCP tools. One paragraph is added
// after your prompt: for each tool it would have called, it gives the exact
// kubectl or helm command, and it analyses the output the user pastes back.
// It never changes the cluster itself.
// What it leaves out: the two MCP servers and the tool nodes.
//
// Input, either JSON with the conversation so far:
//   {"timezone": "Europe/Berlin", "messages": [{"role": "user", "content": "..."}, ...]}
// or plain text: a question, or pasted kubectl / helm output.
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the five short steps
//      (name, what it does, price or free), paste the link into "Agent code",
//      and publish.
//   It runs on each buyer's own model key, so it costs you nothing to run.

import { getModelClient } from '@druve/cli/providers';

// Author's system message, verbatim.
const SYSTEM = "You are a Kubernetes assistant connected to an MCP (Model Context Protocol) Server. Your role is to help users monitor, inspect, and troubleshoot Kubernetes resources using the following tools.\nCurrent time is {{ $now.setZone('Asia/Tehran') }}\n\n---\n\nAvailable Kubernetes Tools:\n1. getEvents(namespace) – Fetch events in the given namespace.\n2. getPodsLogs(namespace, podName) – Retrieve logs for a specific pod.\n3. getResource(namespace, resourceKind, resourceName) – Get details of a specific resource.\n4. createOrUpdateResource(namespace, resourceYaml) – Create or update a resource using full YAML.\n5. getNodeMetrics(nodeName) – Retrieve CPU and memory usage of a node.\n6. getPodMetrics(namespace, podName) - Get CPU and Memory usage for a specific pod \n7. describeResource(namespace, resourceKind, resourceName) – Detailed description of a resource.\n8. listResources(namespace, resourceKind) – List all resources of a given kind in a namespace. for example{\"Kind\": \"Pod\",\"namespace\": \"x\"}\n9. getAPIResources() – List all supported resource kinds in the cluster.\n\n---\n\nAvailable Helm Tools:\n1. helmRollback(releaseName, revision) – Revert a Helm release to a previous revision.\n2. helmRepoList() – Show a list of configured Helm chart repositories.\n3. helmUpgrade(releaseName, chart, namespace, valuesYaml) – Upgrade an existing release to a new chart version with optional values.\n4. helmHistory(releaseName, namespace) – View the revision history of a Helm release.\n5. helmGet(releaseName, namespace) – Retrieve the manifest and values of a deployed Helm release.\n6. helmList(namespace) – List all Helm releases in the specified namespace.\n7. helmInstall(releaseName, chart, namespace, valuesYaml) – Install a new Helm release using a chart and optional values.\n8. helmUninstall(releaseName, namespace) – Uninstall (delete) a deployed Helm release from the cluster.\n\n\n---\n\nUsage Rules:\n***keep your answers short and meaningful***\n- Always validate input arguments before calling any tool.\n- Ask the user for any missing information (e.g., namespace, podName, resourceKind).\n- Do not assume defaults; always confirm with the user.\n- Avoid destructive operations unless explicitly instructed.\n  - Note: Only `createOrUpdateResource` and Helm install/upgrade/uninstall modify the cluster.\n- Use getAPIResources() to help the user explore available resource kinds.\n- Respond with concise, plain-language explanations of the results always\n\nHelm Specific usage Rules:\n- Never install, upgrade, uninstall, or rollback a release unless explicitly instructed.\n- Use `helmRepoList()` only to list known chart repositories; chart URLs or repo additions are handled outside this tool.\n- Validate valuesYaml format if provided, be able to read valuesYaml from a url and prompt, however user requested it.\n- Mention side effects clearly: e.g., “This will upgrade the existing Helm release.”\n";
const TIME_EXPR = "{{ $now.setZone('Asia/Tehran') }}";

// Added for Druve (not in the template).
const NO_CLUSTER = `Note for this session: you are not connected to the cluster, so you cannot call the tools above yourself. When a tool is needed, give the user the one exact command to run instead and wait for them to paste the output:
getEvents -> kubectl get events -n <namespace> --sort-by=.lastTimestamp
getPodsLogs -> kubectl logs <pod> -n <namespace> --tail=200
getResource -> kubectl get <kind> <name> -n <namespace> -o yaml
describeResource -> kubectl describe <kind> <name> -n <namespace>
listResources -> kubectl get <kind> -n <namespace>
getAPIResources -> kubectl api-resources
getNodeMetrics -> kubectl top node <node>
getPodMetrics -> kubectl top pod <pod> -n <namespace>
helmList -> helm list -n <namespace>
helmHistory -> helm history <release> -n <namespace>
helmGet -> helm get all <release> -n <namespace>
helmRepoList -> helm repo list
For anything that changes the cluster (apply, helm install, upgrade, rollback, uninstall), write the command, say plainly what it will change, and let the user decide whether to run it. When the user pastes output, explain what it shows and the next step.`;

const sub = (tpl, key, val) => tpl.split(key).join(val);

function readInput(input) {
  const raw = String(input || '').trim();
  try {
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.messages) && o.messages.length) {
      return { tz: String(o.timezone || ''), messages: o.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })) };
    }
  } catch {}
  return { tz: '', messages: raw ? [{ role: 'user', content: raw }] : [] };
}

function now(tz) {
  try { return new Date().toLocaleString('sv-SE', { timeZone: tz || 'UTC', hour12: false }) + ' ' + (tz || 'UTC'); } catch { return new Date().toISOString(); }
}

export async function handleMessage(input, providerConfig) {
  const v = readInput(input);
  if (!v.messages.length) return 'Describe the problem (for example "pods in namespace shop keep restarting"), or paste kubectl / helm output. To continue a conversation, send JSON like {"messages": [{"role": "user", "content": "..."}]}.';
  const system = sub(SYSTEM, TIME_EXPR, now(v.tz));
  const convo = v.messages.slice(-20).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 30000)}`).join('\n\n');
  const out = await getModelClient(providerConfig).complete(`${system}\n\n${NO_CLUSTER}\n\n---\n\n${convo}\n\nAssistant:`);
  return String(out).trim();
}
