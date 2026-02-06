declare global {
  namespace Express {
    interface Request {
      user?: {
        id: number;
        type: "parent" | "child";
      };
    }
  }
}

export {};
