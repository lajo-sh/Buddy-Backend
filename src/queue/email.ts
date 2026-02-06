import { Queue, Worker } from "bullmq";
import { connection } from "../db/redis/info";
import { getTransporter } from "../email/email";
import { verificationEmailHtml } from "../email/confirm";
import { logger } from "../lib/pino";

/** Queue for handling email verification messages */
export const verificationEmailQueue = new Queue("verificationEmailQueue", {
  connection,
});

/** Worker that processes verification email jobs from the queue */
export const verificationEmailWorker = new Worker(
  "verificationEmailQueue",
  async (job) => {
    const { email, code } = job.data;
    logger.info({ jobId: job.id, email }, "Processing verification email job");

    try {
      await getTransporter().sendMail({
        from: `"Buddy 🐶" <${process.env.SMTP_EMAIL}>`,
        to: email,
        subject: "Buddy email verification",
        html: verificationEmailHtml(code),
      });
      logger.info(
        { jobId: job.id, email },
        "Verification email sent successfully",
      );
      return { success: true };
    } catch (error) {
      logger.error(
        { error, jobId: job.id, email },
        "Failed to send verification email",
      );
      throw error;
    }
  },
  {
    connection,
    concurrency: 5,
  },
);

verificationEmailWorker.on("active", (job) => {
  logger.debug(
    { jobId: job!.id, email: job!.data.email },
    "Email job is active",
  );
});

verificationEmailWorker.on("completed", (job) => {
  logger.info(
    { jobId: job!.id, email: job!.data.email },
    "Email job completed",
  );
});

verificationEmailWorker.on("error", (err) => {
  logger.error({ error: err }, "Email worker error");
});

verificationEmailWorker.on("failed", (job, err) => {
  logger.error(
    { error: err, jobId: job?.id, email: job?.data.email },
    "Email job failed",
  );
});
