"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { PossumMark } from "@/components/brand/possum-mark";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { signUp } from "@/lib/auth-client";
import { browserTimezone } from "@/lib/browser-timezone";
import { cn } from "@/lib/utils";

const signUpSchema = z.object({
  email: z.email("Enter a valid email address."),
  inviteCode: z.string().min(1, "Enter your invite code."),
  name: z.string().min(1, "Enter your name."),
  password: z.string().min(8, "Password must be at least 8 characters."),
});

type SignUpValues = z.infer<typeof signUpSchema>;

export const SignupForm = ({
  className,
  ...props
}: React.ComponentProps<"div">) => {
  const [showPassword, setShowPassword] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    setError,
  } = useForm<SignUpValues>({
    defaultValues: { email: "", inviteCode: "", name: "", password: "" },
    resolver: zodResolver(signUpSchema),
  });

  const onSubmit = async (values: SignUpValues) => {
    // The account's own zone, stored once here so that a request carrying no
    // viewer zone still knows where the reader lives. The browser is the only
    // party that knows it at this point.
    const { error } = await signUp.email({
      ...values,
      timezone: browserTimezone(),
    });
    if (error) {
      setError("root", { message: error.message ?? "Failed to sign up" });
      return;
    }
    // A real navigation so the server layout re-reads the new session — see
    // the note in `login-form.tsx`.
    window.location.assign("/");
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <form noValidate onSubmit={handleSubmit(onSubmit)}>
        <FieldGroup>
          <div className="flex flex-col items-center gap-2 text-center">
            <Link
              href="/"
              className="flex flex-col items-center gap-2 font-medium"
            >
              <PossumMark className="size-16" ground="var(--background)" />
              <span className="sr-only">possum</span>
            </Link>
            <h1 className="text-xl font-bold">Create an account</h1>
            <FieldDescription>
              Already have an account? <Link href="/sign-in">Sign in</Link>
            </FieldDescription>
          </div>
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor="name">Name</FieldLabel>
            <Input
              {...register("name")}
              aria-invalid={!!errors.name}
              autoComplete="name"
              id="name"
              required
              type="text"
            />
            <FieldError errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              {...register("email")}
              aria-invalid={!!errors.email}
              autoComplete="email"
              id="email"
              placeholder="m@example.com"
              required
              type="email"
            />
            <FieldError errors={[errors.email]} />
          </Field>
          <Field data-invalid={!!errors.inviteCode}>
            <FieldLabel htmlFor="inviteCode">Invite code</FieldLabel>
            <Input
              {...register("inviteCode")}
              aria-invalid={!!errors.inviteCode}
              autoComplete="off"
              id="inviteCode"
              required
            />
            <FieldDescription>
              Enter the invite code you were given to create an account
            </FieldDescription>
            <FieldError errors={[errors.inviteCode]} />
          </Field>
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="password">Password</FieldLabel>
            <InputGroup>
              <InputGroupInput
                {...register("password")}
                aria-invalid={!!errors.password}
                autoComplete="new-password"
                id="password"
                minLength={8}
                required
                type={showPassword ? "text" : "password"}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupButton
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  className="relative touch-manipulation after:absolute after:-inset-3 after:content-['']"
                  onClick={() => setShowPassword((visible) => !visible)}
                  size="icon-xs"
                  type="button"
                >
                  {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
            <FieldError errors={[errors.password, errors.root]} />
          </Field>
          <Field>
            <Button disabled={isSubmitting} type="submit">
              {isSubmitting ? "Creating account…" : "Sign up"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
};
