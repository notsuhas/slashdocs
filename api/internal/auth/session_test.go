package auth_test

import (
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

func TestSessionCodecRoundTrip(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.Sign("usr_1")
	uid, ok := codec.VerifySession(tok)
	if !ok || uid != "usr_1" {
		t.Fatalf("VerifySession = (%q, %v), want (\"usr_1\", true)", uid, ok)
	}
}

func TestSessionCodecRejectsWrongSecret(t *testing.T) {
	tok := (auth.SessionCodec{Secret: []byte("secret-a")}).Sign("usr_1")
	if _, ok := (auth.SessionCodec{Secret: []byte("secret-b")}).VerifySession(tok); ok {
		t.Fatal("session signed with a different secret verified")
	}
}

func TestSessionCodecRejectsTamperedToken(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.Sign("usr_1")
	tampered := []byte(tok)
	// Flip a character inside the payload segment (after the "v1." prefix).
	if tampered[4] == 'A' {
		tampered[4] = 'B'
	} else {
		tampered[4] = 'A'
	}
	if _, ok := codec.VerifySession(string(tampered)); ok {
		t.Fatal("tampered session token verified")
	}
}

func TestSessionCodecRejectsMalformedTokens(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	for _, tok := range []string{"", "v1", "v1.only-two", "v2.a.b", "v1.!!!.!!!"} {
		if _, ok := codec.VerifySession(tok); ok {
			t.Fatalf("malformed token %q verified", tok)
		}
	}
}

func TestSessionCodecRejectsExpiredToken(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.SignForAudience("usr_1", "session", -time.Minute)
	if _, ok := codec.VerifySession(tok); ok {
		t.Fatal("expired session token verified")
	}
}

func TestSessionCodecRejectsWrongAudience(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	tok := codec.SignForAudience("ver_1", "render", time.Hour)
	if _, ok := codec.VerifySession(tok); ok {
		t.Fatal("render-audience token accepted as a session")
	}
	uid, ok := codec.VerifyAudience(tok, "render")
	if !ok || uid != "ver_1" {
		t.Fatalf("VerifyAudience(render) = (%q, %v), want (\"ver_1\", true)", uid, ok)
	}
}

func TestSessionDetailsRequiresValidSession(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	session, ok := codec.VerifySessionDetails(codec.Sign("user"))
	expiry := session.ExpiresAt
	if !ok || expiry <= time.Now().Unix() {
		t.Fatalf("expiry=%d ok=%v", expiry, ok)
	}
	for _, token := range []string{"", "v1.broken.token", codec.SignForAudience("user", "render", time.Hour), codec.SignForAudience("user", "session", -time.Hour), (auth.SessionCodec{Secret: []byte("other")}).Sign("user")} {
		if _, ok := codec.VerifySessionDetails(token); ok {
			t.Fatal("accepted invalid session")
		}
	}
}

func TestSessionCredentialsAreUniquePerLogin(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	first, second := codec.Sign("user"), codec.Sign("user")
	if first == second {
		t.Fatal("separate logins reused a session credential")
	}
	for _, token := range []string{first, second} {
		if _, ok := codec.VerifySessionDetails(token); !ok {
			t.Fatal("new session did not verify")
		}
	}
}

func TestSessionKeyIDCannotForgeTokens(t *testing.T) {
	for _, length := range []int{32, 64, 65, 88, 128} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			codec := auth.SessionCodec{Secret: []byte(strings.Repeat("s", length))}
			key, err := hex.DecodeString(codec.SigningKeyID())
			if err != nil {
				t.Fatal(err)
			}
			attacker := auth.SessionCodec{Secret: key}
			for _, audience := range []string{"session", "render", "mcp"} {
				forged := attacker.SignForAudience("victim-admin", audience, time.Hour)
				if _, ok := codec.VerifyAudience(forged, audience); ok {
					t.Fatalf("stored key ID forged %s token", audience)
				}
			}
		})
	}
}

func TestSignedSessionMetadataMatchesVerification(t *testing.T) {
	codec := auth.SessionCodec{Secret: []byte("test-secret")}
	token, signed := codec.SignSession("user")
	verified, ok := codec.VerifySessionDetails(token)
	if !ok || signed != verified {
		t.Fatalf("signed = %+v, verified = %+v, ok = %v", signed, verified, ok)
	}
}
