import { requireSession } from "./auth";
import { ApiError } from "./contracts";
import { ADMIN_EMAIL } from "../shared/admin";

export async function requireAdmin(request: Request, env: Env) {
  let user;
  try {
    user = await requireSession(request, env);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("admin_auth_failed", error);
    throw new ApiError(503, "admin_unavailable");
  }
  if (user.email?.trim().toLowerCase() !== ADMIN_EMAIL) throw new ApiError(403, "forbidden");
  return user;
}
