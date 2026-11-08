import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Prose } from "./Prose";

describe("Prose", () => {
  it("renders the markdown subset", () => {
    const { container } = render(<Prose text={"Hello **bold** and `code`.\n\n- one\n- two\n\n```python\nx = 1\n```"} />);
    expect(container.querySelector("strong")?.textContent).toBe("bold");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.querySelector("pre code")?.textContent).toBe("x = 1");
  });

  it("never interprets HTML in lesson text", () => {
    const { container } = render(<Prose text={'<img src=x onerror="alert(1)"> <script>bad()</script>'} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img");
  });
});
