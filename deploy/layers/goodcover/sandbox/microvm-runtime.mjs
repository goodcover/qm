import "./agent.mjs";
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const resolver = "nameserver 172.16.31.250\noptions timeout:2 attempts:3\n";
const prefix = "/aws/lambda-microvms/runtime/v1/";
http
  .createServer((req, res) => {
    if (req.method !== "POST" || !["ready", "run", "resume"].some((name) => req.url === prefix + name)) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (req.url !== prefix + "ready" && readFileSync("/etc/resolv.conf", "utf8") !== resolver) {
        writeFileSync("/run/qm-resolv.conf", resolver);
        execFileSync("/usr/bin/mount", ["--bind", "/run/qm-resolv.conf", "/etc/resolv.conf"], { stdio: "pipe" });
      }
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    } catch (error) {
      console.error("Native DNS setup failed:", error.code ?? error.name);
      res.writeHead(500).end();
    }
  })
  .listen(8082, "0.0.0.0");
