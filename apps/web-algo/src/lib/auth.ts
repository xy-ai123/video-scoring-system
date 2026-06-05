export type AdminSession = {
  user: { email: string; isAdmin: true };
  expires: string;
};

export async function getCurrentAdmin(): Promise<AdminSession | null> {
  if (
    process.env.AUTH_BYPASS === "true" &&
    process.env.NODE_ENV !== "production"
  ) {
    return {
      user: { email: "bypass@local", isAdmin: true },
      expires: new Date(Date.now() + 86_400_000).toISOString(),
    };
  }
  const { cookies } = await import("next/headers");
  const { COOKIE_NAME, verifySessionToken } = await import("./session");
  const token = cookies().get(COOKIE_NAME)?.value;
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  return {
    user: { email: payload.sub, isAdmin: true },
    expires: new Date(payload.exp).toISOString(),
  };
}
