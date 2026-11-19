// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AboutYouSettings } from "./AboutYouSettings";

const service = vi.hoisted(() => ({
  getProfile: vi.fn(),
  setProfile: vi.fn(),
}));
vi.mock("../../services/agent", () => ({ ...service, errorMessage: String }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  toast.error.mockClear();
  service.getProfile.mockReset().mockResolvedValue({ name: "Mick", about: "" });
  service.setProfile.mockReset().mockImplementation((profile: { name: string; about: string }) =>
    Promise.resolve({ name: profile.name.trim(), about: profile.about.trim() }));
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => { root.render(<AboutYouSettings />); });
});

afterEach(() => {
  act(() => root.unmount());
  document.body.replaceChildren();
});

const name = () => container.querySelector<HTMLInputElement>("#writer-name")!;
const about = () => container.querySelector<HTMLTextAreaElement>("#writer-about")!;
function type(field: HTMLInputElement | HTMLTextAreaElement, text: string) {
  act(() => {
    const prototype = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const blur = async (field: HTMLElement) => {
  await act(async () => { field.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
};

it("shows the saved profile and saves an edit when the field is left", async () => {
  expect(name().value).toBe("Mick");
  type(about(), "  I run a consultancy.  ");
  expect(service.setProfile).not.toHaveBeenCalled();
  await blur(about());
  expect(service.setProfile).toHaveBeenCalledWith({ name: "Mick", about: "  I run a consultancy.  " });
  expect(about().value).toBe("I run a consultancy.");
});

it("does not save when nothing changed", async () => {
  type(name(), "Mick");
  await blur(name());
  expect(service.setProfile).not.toHaveBeenCalled();
});

it("saves what was typed when settings closes before the field loses focus", () => {
  type(name(), "Mick Ryan");
  act(() => root.unmount());
  expect(service.setProfile).toHaveBeenCalledWith({ name: "Mick Ryan", about: "" });
  root = createRoot(container);
});

it("keeps the typed text and reports the reason when saving fails", async () => {
  service.setProfile.mockRejectedValueOnce("About you can be at most 2000 characters.");
  type(about(), "too long");
  await blur(about());
  expect(toast.error).toHaveBeenCalledWith("About you can be at most 2000 characters.");
  expect(about().value).toBe("too long");
});
