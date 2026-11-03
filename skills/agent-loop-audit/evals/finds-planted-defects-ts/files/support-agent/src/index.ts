import { runAgent } from "./agent.js";

const SYSTEM = `You are a support agent for Northwind. Answer from the knowledge base
and cite the article paths you read. Issue refunds only when the customer is clearly
entitled to one. Escalate anything you cannot resolve.`;

const question = process.argv.slice(2).join(" ");
if (!question) {
  console.error("usage: npm start -- '<customer question>'");
  process.exit(1);
}

const result = await runAgent(question, SYSTEM);
console.log(`\n${result.text}\n(${result.steps} steps)`);
