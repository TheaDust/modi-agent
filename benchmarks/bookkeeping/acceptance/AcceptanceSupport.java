package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;

import com.yanimetaxas.bookkeeping.ChartOfAccounts;
import com.yanimetaxas.bookkeeping.ChartOfAccounts.ChartOfAccountsBuilder;
import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.Ledger.LedgerBuilder;
import com.yanimetaxas.bookkeeping.model.Money;
import com.yanimetaxas.bookkeeping.model.TransferRequest;
import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;

/** Shared helpers for the frozen acceptance tests. */
final class AcceptanceSupport {

  /** A period inside January 2026; the instant is midday so any zone keeps the same month. */
  static final String PERIOD = "2026-01";

  static final Clock CLOCK = Clock.fixed(Instant.parse("2026-01-15T12:00:00Z"), ZoneOffset.UTC);

  private AcceptanceSupport() {}

  static Ledger ledger(String name, String cashAmount) {
    return ledger(name, cashAmount, "0.00");
  }

  /**
   * 收入账户默认无余额；需要从收入账户借记的用例必须显式给它资金，
   * 否则会被项目原有的余额校验（InsufficientFundsException）先拦下，测不到目标行为。
   */
  static Ledger ledger(String name, String cashAmount, String revenueAmount) {
    ChartOfAccounts chart =
        new ChartOfAccountsBuilder()
            .create("CASH", cashAmount, "EUR")
            .create("REVENUE", revenueAmount, "EUR")
            .build();
    return new LedgerBuilder(chart).name(name).clock(CLOCK).build().init();
  }

  /** Debits CASH and credits REVENUE by the same amount. */
  static TransferRequest payment(Ledger ledger, String reference, String amount) {
    return debitFrom(ledger, reference, "CASH", "REVENUE", amount);
  }

  static TransferRequest debitFrom(
      Ledger ledger, String reference, String from, String to, String amount) {
    return ledger
        .createTransferRequest()
        .reference(reference)
        .type("payout")
        .account(from)
        .debit(amount, "EUR")
        .account(to)
        .credit(amount, "EUR")
        .build();
  }

  /** Money equality is scale sensitive, so compare the plain numeric value instead. */
  static void assertAmount(Money actual, String expected) {
    assertThat(actual.getAmount().stripTrailingZeros().toPlainString())
        .isEqualTo(new BigDecimal(expected).stripTrailingZeros().toPlainString());
    assertThat(actual.getCurrency().getCurrencyCode()).isEqualTo("EUR");
  }

  static void assertAmount(Money actual, String expected, String currency) {
    assertThat(actual.getAmount().stripTrailingZeros().toPlainString())
        .isEqualTo(new BigDecimal(expected).stripTrailingZeros().toPlainString());
    assertThat(actual.getCurrency().getCurrencyCode()).isEqualTo(currency);
  }

  /** For amounts whose sign convention the requirement leaves open. */
  static void assertAmountAbs(Money actual, String expected) {
    assertThat(actual.getAmount().abs().stripTrailingZeros().toPlainString())
        .isEqualTo(new BigDecimal(expected).stripTrailingZeros().toPlainString());
    assertThat(actual.getCurrency().getCurrencyCode()).isEqualTo("EUR");
  }
}
