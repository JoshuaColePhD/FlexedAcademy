import { AuthLayout } from './AuthLayout'
import { SignInForm } from '../../components/SignInForm'

export default function LoginPage() {
  return (
    <AuthLayout title="Sign in" subtitle="Use your school Google account or an email.">
      <div className="mt-6">
        <SignInForm idPrefix="login-" />
      </div>
    </AuthLayout>
  )
}
