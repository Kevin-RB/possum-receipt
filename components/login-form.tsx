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
import { signIn } from "@/lib/auth-client";
import { cn } from "@/lib/utils";

const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

type SignInValues = z.infer<typeof signInSchema>;

export const LoginForm = ({
  className,
  ...props
}: React.ComponentProps<"div">) => {
  const [showPassword, setShowPassword] = useState(false);
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    setError,
  } = useForm<SignInValues>({
    defaultValues: { email: "", password: "" },
    resolver: zodResolver(signInSchema),
  });

  const onSubmit = async (values: SignInValues) => {
    const { error } = await signIn.email(values);
    if (error) {
      setError("root", { message: error.message ?? "Failed to sign in" });
      return;
    }
    // A real navigation, not `router.push`. The Router Cache may hold a
    // prefetch of `/` from before the session existed (the logo links to it),
    // and `router.refresh()` after a push races the in-flight navigation in
    // Next.js 16, leaving a blank page. A full load re-runs the server layout
    // with the new cookie.
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
            <h1 className="text-xl font-bold">Possum receipts</h1>
            <p className="text-muted-foreground text-balance">
              Give your receipts a new home
            </p>
            <FieldDescription>
              Don&apos;t have an account? <Link href="/sign-up">Sign up</Link>
            </FieldDescription>
          </div>
          <Field data-invalid={!!errors.email}>
            <FieldLabel htmlFor="email">Email</FieldLabel>
            <Input
              {...register("email")}
              aria-invalid={!!errors.email}
              autoComplete="username"
              id="email"
              placeholder="m@example.com"
              required
              spellCheck={false}
              type="email"
            />
            <FieldError errors={[errors.email]} />
          </Field>
          <Field data-invalid={!!errors.password}>
            <FieldLabel htmlFor="current-password">Password</FieldLabel>
            <InputGroup>
              <InputGroupInput
                {...register("password")}
                aria-invalid={!!errors.password}
                autoComplete="current-password"
                id="current-password"
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
              {isSubmitting ? "Signing in…" : "Sign in"}
            </Button>
          </Field>
        </FieldGroup>
      </form>
    </div>
  );
};
