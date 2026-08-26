/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxyEntry } from "../../../shared/types";

vi.mock("../../../shared/i18n/context", () => ({
  useT: () => (key: string) => key,
}));

import { RuleAssign } from "./RuleAssign";

const proxies: ProxyEntry[] = [
  { id: "active-proxy", name: "Active proxy", url: "http://active", status: "active", health: null, addedAt: "" },
  { id: "disabled-proxy", name: "Disabled proxy", url: "http://disabled", status: "disabled", health: null, addedAt: "" },
];

describe("RuleAssign", () => {
  afterEach(() => cleanup());

  it("does not show disabled proxies as assignment targets", () => {
    render(
      <RuleAssign
        proxies={proxies}
        selectedCount={1}
        onAssign={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Active proxy")).toBeTruthy();
    expect(screen.queryByText("Disabled proxy")).toBeNull();
  });
});
