package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;

import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.model.Money;
import com.yanimetaxas.bookkeeping.model.ReconciliationEntry;
import com.yanimetaxas.bookkeeping.model.ReconciliationResult;
import com.yanimetaxas.bookkeeping.service.ReconciliationService;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Frozen acceptance checks for R3: reconciling balances against an external statement. */
class R3AcceptanceTest {

  @Test
  void matchingBalancesAreFullyReconciled() {
    Ledger ledger = AcceptanceSupport.ledger("r3-match", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));
    ReconciliationService reconciliation = ledger.reconciliationService();

    ReconciliationResult result =
        reconciliation.reconcile("STMT-1", Map.of("CASH", Money.toMoney("950.00", "EUR")));

    assertThat(result.getReference()).isEqualTo("STMT-1");
    assertThat(result.isFullyReconciled()).isTrue();
    assertThat(result.getEntries()).hasSize(1);
    ReconciliationEntry entry = result.getEntries().get(0);
    assertThat(entry.getAccountRef()).isEqualTo("CASH");
    AcceptanceSupport.assertAmount(entry.getExpected(), "950.00");
    AcceptanceSupport.assertAmount(entry.getActual(), "950.00");
    AcceptanceSupport.assertAmount(entry.getDifference(), "0.00");
    assertThat(entry.isReconciled()).isTrue();
  }

  @Test
  void aDifferentBalanceIsReportedAsNotReconciled() {
    Ledger ledger = AcceptanceSupport.ledger("r3-mismatch", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));
    ReconciliationService reconciliation = ledger.reconciliationService();

    ReconciliationResult result =
        reconciliation.reconcile("STMT-2", Map.of("CASH", Money.toMoney("900.00", "EUR")));

    assertThat(result.isFullyReconciled()).isFalse();
    ReconciliationEntry entry = result.getEntries().get(0);
    assertThat(entry.isReconciled()).isFalse();
    AcceptanceSupport.assertAmount(entry.getExpected(), "900.00");
    AcceptanceSupport.assertAmount(entry.getActual(), "950.00");
    AcceptanceSupport.assertAmount(entry.getDifference(), "-50.00");
  }

  @Test
  void anUnknownAccountIsReportedAsNotReconciledWithoutFailing() {
    Ledger ledger = AcceptanceSupport.ledger("r3-unknown", "1000.00");
    ReconciliationService reconciliation = ledger.reconciliationService();

    ReconciliationResult result =
        reconciliation.reconcile("STMT-3", Map.of("GHOST", Money.toMoney("10.00", "EUR")));

    assertThat(result.isFullyReconciled()).isFalse();
    ReconciliationEntry entry = result.getEntries().get(0);
    assertThat(entry.getAccountRef()).isEqualTo("GHOST");
    assertThat(entry.isReconciled()).isFalse();
    AcceptanceSupport.assertAmount(entry.getActual(), "0.00");
    AcceptanceSupport.assertAmount(entry.getDifference(), "10.00");
  }

  @Test
  void accountsOutsideTheStatementAreNotListed() {
    Ledger ledger = AcceptanceSupport.ledger("r3-scope", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));
    ReconciliationService reconciliation = ledger.reconciliationService();

    ReconciliationResult result =
        reconciliation.reconcile("STMT-4", Map.of("CASH", Money.toMoney("950.00", "EUR")));

    assertThat(result.getEntries()).hasSize(1);
    assertThat(result.getEntries().get(0).getAccountRef()).isEqualTo("CASH");
  }

  @Test
  void reconciliationChangesNoBalancesAndNoTransactions() {
    Ledger ledger = AcceptanceSupport.ledger("r3-readonly", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));
    ReconciliationService reconciliation = ledger.reconciliationService();

    reconciliation.reconcile("STMT-5", Map.of("CASH", Money.toMoney("950.00", "EUR")));

    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "950.00");
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("REVENUE"), "50.00");
    assertThat(ledger.getTransactionByRef("T1")).isNotNull();
  }
}
