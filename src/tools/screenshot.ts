// screenshot: lets the model see what it built. Renders a URL or a local HTML
// file in a headless Chrome/Edge that is already installed and returns the
// image together with the errors the page reported, so the model can critique
// its own interface and fix it.

import { c } from "../ui/term.ts";
import { openPage, resolveTarget } from "./browser.ts";
import type { Tool } from "./types.ts";

export { findBrowser } from "./browser.ts";

export const errorsText = (errors: string[]) => (errors.length ? `\n\nThe page reported ${errors.length} error${errors.length === 1 ? "" : "s"}:\n${errors.map((e) => `- ${e}`).join("\n")}` : "\n\nThe page reported no errors.");

export const screenshotTool: Tool = {
  kind: "exec",
  spec: {
    name: "screenshot",
    description:
      "Render a web page in a headless browser and get the image back, together with the errors the page reported (uncaught exceptions, console.error, failed requests), so you can see what you built. `target` is a URL (for example http://localhost:3000/) or a path to a local HTML file. Use it after building or changing anything visual: look at the result critically (alignment, spacing, hierarchy, contrast, overflow), fix what is wrong, and take another. Take one at the default desktop size and one with `mobile` true. A dev server must already be running. WebGL works (software rendering). For a three.js scene, `scene3d` tells you more.",
    input_schema: {
      type: "object",
      properties: {
        target: { type: "string", description: "URL, or path to a local HTML file." },
        mobile: { type: "boolean", description: "Use a phone-sized viewport (390x844)." },
        width: { type: "integer", description: "Viewport width in pixels (default 1280)." },
        height: { type: "integer", description: "Viewport height in pixels (default 800; raise it to capture a long page)." },
        wait: { type: "integer", description: "Milliseconds to let the page run after loading before the picture is taken (default 1200, at most 10000)." },
      },
      required: ["target"],
    },
  },
  summarize: (i) => String(i.target ?? "") + (i.mobile ? c.dim(" (mobile)") : ""),
  async run(input, ctx) {
    const target = await resolveTarget(String(input.target), ctx.cwd);
    if (!target) return { content: `File not found: ${input.target}`, isError: true };
    const url = target.url;
    const width = Math.min(3840, Math.max(240, Number(input.width) || (input.mobile ? 390 : 1280)));
    const height = Math.min(6000, Math.max(240, Number(input.height) || (input.mobile ? 844 : 800)));
    let page;
    try {
      page = await openPage(url, { width, height, mobile: !!input.mobile, signal: ctx.signal, settleMs: Math.min(10_000, Math.max(0, Number(input.wait) || 1200)) });
    } catch (err) {
      target.close();
      return { content: `Screenshot failed: ${(err as Error).message}. Tell the user the visual result is unverified.`, isError: true };
    }
    try {
      const data = await page.screenshot();
      if (data.length > 4_500_000) return { content: `The screenshot is too large to send (${data.length} bytes). Use a smaller width or height.`, isError: true };
      return {
        content: [
          { type: "text", text: `Screenshot of ${target.label} at ${width}x${height}.${errorsText(page.errors)}` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } },
        ],
        display: [c.dim(`${width}x${height}, ${Math.round(data.length / 1024)} KB`) + (page.errors.length ? c.red(` · ${page.errors.length} page error${page.errors.length === 1 ? "" : "s"}`) : "")],
      };
    } catch (err) {
      return { content: `Screenshot failed: ${(err as Error).message}`, isError: true };
    } finally {
      page.close();
      target.close();
    }
  },
};
