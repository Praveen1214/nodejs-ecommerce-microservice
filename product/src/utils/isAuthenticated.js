require("dotenv").config();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || "http://auth:3000";

async function isAuthenticated(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const response = await fetch(`${AUTH_SERVICE_URL}/verify`, {
      method: "POST",
      headers: { "Authorization": authHeader },
    });
    const data = await response.json();

    if (response.ok && data.valid) {
      req.user = data.user;
      next();
    } else {
      res.status(401).json({ message: "Unauthorized" });
    }
  } catch (err) {
    console.error("Auth service call failed:", err.message);
    res.status(503).json({ message: "Auth service unavailable" });
  }
}

module.exports = isAuthenticated;
