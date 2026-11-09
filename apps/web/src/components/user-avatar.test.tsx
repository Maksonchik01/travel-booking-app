import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { initials, UserAvatar } from "./user-avatar";

describe("UserAvatar", () => {
  it("prefers own photo, then Google, then initials", () => {
    const user = { username: "max", first_name: "Макс", last_name: "Демченко" };
    const { rerender } = render(
      <UserAvatar
        user={{ ...user, avatar_version: 7, google_picture: "https://lh3.googleusercontent.com/a" }}
        size={40}
      />,
    );
    expect(screen.getByTestId("user-avatar").getAttribute("src")).toBe("/api/account/avatar?v=7");

    rerender(
      <UserAvatar
        user={{ ...user, google_picture: "https://lh3.googleusercontent.com/a" }}
        size={40}
      />,
    );
    expect(screen.getByTestId("user-avatar").getAttribute("src")).toContain("googleusercontent");

    rerender(<UserAvatar user={user} size={40} />);
    expect(screen.getByTestId("user-avatar")).toHaveTextContent("МД");
  });

  it("falls back to the username letter", () => {
    expect(initials({ username: "max" })).toBe("M");
    expect(initials({ username: "max", first_name: " анна " })).toBe("А");
  });
});
