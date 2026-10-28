import type { OutboundEmail } from "./email.transport";

/**
 * The messages the installation sends.
 *
 * English and Arabic in one message rather than a choice between them: the
 * server does not know the recipient's language before they have signed in,
 * and an invitation is by definition sent to somebody who never has.
 *
 * Every value interpolated into HTML goes through `escape` — a workspace name
 * and a person's name are typed by other people.
 */

const escape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatExpiry = (expiresAt: Date): string =>
  expiresAt.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC"
  }) + " UTC";

interface Section {
  heading: string;
  paragraphs: string[];
  button: string;
  footnote: string;
}

function render(subject: string, link: string, en: Section, ar: Section): OutboundEmail {
  const block = (section: Section, dir: "ltr" | "rtl") => `
    <div dir="${dir}" style="text-align:${dir === "rtl" ? "right" : "left"};margin:0 0 32px">
      <h1 style="font-size:20px;color:#002559;margin:0 0 16px">${escape(section.heading)}</h1>
      ${section.paragraphs
        .map((p) => `<p style="font-size:15px;line-height:1.6;color:#1f2937;margin:0 0 12px">${escape(p)}</p>`)
        .join("")}
      <p style="margin:24px 0">
        <a href="${escape(link)}" style="display:inline-block;background:#F24C1A;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 24px;border-radius:8px">${escape(section.button)}</a>
      </p>
      <p style="font-size:13px;line-height:1.5;color:#6b7280;margin:0">${escape(section.footnote)}</p>
    </div>`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f3f4f6;font-family:Segoe UI,Arial,sans-serif">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px">
    <p style="font-size:14px;font-weight:700;color:#002559;letter-spacing:.04em;margin:0 0 24px">GROW PATH</p>
    ${block(en, "ltr")}
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:0 0 32px">
    ${block(ar, "rtl")}
    <p style="font-size:12px;color:#9ca3af;word-break:break-all;margin:24px 0 0">${escape(link)}</p>
  </div>
</body></html>`;

  const textBlock = (section: Section) =>
    [section.heading, "", ...section.paragraphs, "", `${section.button}: ${link}`, "", section.footnote].join("\n");

  return {
    to: "",
    subject,
    html,
    text: `${textBlock(en)}\n\n----\n\n${textBlock(ar)}`
  };
}

export interface InvitationEmailInput {
  link: string;
  expiresAt: Date;
  /** The workspace being joined, when the caller knows it. */
  workspaceName?: string | null;
  /** The invitee's name, when one was given. */
  name?: string | null;
}

export function invitationEmail(input: InvitationEmailInput): OutboundEmail {
  const expiry = formatExpiry(input.expiresAt);
  const workspace = input.workspaceName?.trim();
  const greetingEn = input.name?.trim() ? `Hello ${input.name.trim()},` : "Hello,";
  const greetingAr = input.name?.trim() ? `مرحبًا ${input.name.trim()}،` : "مرحبًا،";

  return render(
    workspace ? `You're invited to ${workspace} on Grow Path` : "You're invited to Grow Path",
    input.link,
    {
      heading: workspace ? `Join ${workspace} on Grow Path` : "Join Grow Path",
      paragraphs: [
        greetingEn,
        workspace
          ? `You have been invited to the ${workspace} workspace. Choose a password to activate your account; you will use it to sign in to the admin portal and the mobile app.`
          : "You have been invited to Grow Path. Choose a password to activate your account; you will use it to sign in to the admin portal and the mobile app."
      ],
      button: "Accept invitation",
      footnote: `This link works once and expires on ${expiry}. If you were not expecting it, you can ignore this email.`
    },
    {
      heading: workspace ? `انضم إلى ${workspace} على Grow Path` : "انضم إلى Grow Path",
      paragraphs: [
        greetingAr,
        workspace
          ? `تمت دعوتك إلى مساحة العمل ${workspace}. اختر كلمة مرور لتفعيل حسابك، وستستخدمها لتسجيل الدخول إلى بوابة الإدارة وتطبيق الجوال.`
          : "تمت دعوتك إلى Grow Path. اختر كلمة مرور لتفعيل حسابك، وستستخدمها لتسجيل الدخول إلى بوابة الإدارة وتطبيق الجوال."
      ],
      button: "قبول الدعوة",
      footnote: `يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته في ${expiry}. إن لم تكن تتوقعه، يمكنك تجاهل هذه الرسالة.`
    }
  );
}

export interface PasswordResetEmailInput {
  link: string;
  expiresAt: Date;
}

export function passwordResetEmail(input: PasswordResetEmailInput): OutboundEmail {
  const expiry = formatExpiry(input.expiresAt);
  return render(
    "Reset your Grow Path password",
    input.link,
    {
      heading: "Reset your password",
      paragraphs: [
        "Hello,",
        "Someone asked to reset the password for your Grow Path account. Use the button below to choose a new one."
      ],
      button: "Choose a new password",
      footnote: `This link works once and expires on ${expiry}. If you did not ask for it, ignore this email — your password stays as it is.`
    },
    {
      heading: "إعادة تعيين كلمة المرور",
      paragraphs: [
        "مرحبًا،",
        "طلب أحدهم إعادة تعيين كلمة المرور لحسابك على Grow Path. استخدم الزر أدناه لاختيار كلمة مرور جديدة."
      ],
      button: "اختيار كلمة مرور جديدة",
      footnote: `يعمل هذا الرابط مرة واحدة وتنتهي صلاحيته في ${expiry}. إن لم تطلبه، تجاهل هذه الرسالة وستبقى كلمة مرورك كما هي.`
    }
  );
}
