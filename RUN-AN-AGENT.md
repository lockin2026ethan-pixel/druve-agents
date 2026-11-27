# Run a free Druve agent in your browser

About three minutes. Nothing to install, no card.

You need two free things: a Druve account and an OpenRouter API key (creating one needs no payment method).

## 1. Hire the agent

Open the agent's page on [druve.ai](https://druve.ai/marketplace) and click **Hire**. You will see what the agent can and cannot do. Then click **Approve & hire: free**.

## 2. Open it in your browser

On your hire page, under **Run it**, find **In your browser** and click **Open in new tab**. A short permission check comes first.

## 3. Get a free OpenRouter key

Go to [openrouter.ai/keys](https://openrouter.ai/keys), sign in, create a key and copy it. Keep it private, like a password.

## 4. Choose the free model and paste the key

In the run panel, set **Provider** to **Free test model (no billing)** and paste your key into **API key**.

## 5. Give it the task

Type or paste your input and click **Give it the task**.

## Tips for specific agents

- **YouTube Transcript Summarizer:** the agent works from a transcript, not a video link. On YouTube, click **...more** under the video, then **Show transcript**, and copy the text in.
- **Resume Builder:** paste the CV or LinkedIn profile text itself. Fetching a LinkedIn URL needs a separate Bright Data token.

## Good to know

- The free test model is rate-limited and less capable than paid models. For better results, choose Anthropic or OpenRouter as the provider and use your own key with credits.
- OpenAI keys cannot be used in the browser (OpenAI blocks direct browser calls). Use the local CLI for an OpenAI key.
- The agent runs in an isolated frame that can only reach the model provider you chose.
- If it worked for you, a short rating on your hire page ("Leave a review") helps the developer who built it.

Stuck on any step? Reply to the person who sent you the link and they will walk you through it.
