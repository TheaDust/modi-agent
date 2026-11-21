package com.yanimetaxas.bookkeeping.acceptance;

import static io.github.imetaxas.realitycheck.RealityAssertions.assertThat;

import com.yanimetaxas.bookkeeping.Ledger;
import com.yanimetaxas.bookkeeping.model.AccountPosting;
import com.yanimetaxas.bookkeeping.service.PostingHistoryService;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Frozen acceptance checks for R4: recording and reading the actor of a posting. */
class R4AcceptanceTest {

  @Test
  void theActorIsRecordedOnTheTransaction() {
    Ledger ledger = AcceptanceSupport.ledger("r4-actor", "1000.00");

    ledger.commit(
        ledger
            .createTransferRequest()
            .reference("T1")
            .type("sale")
            .account("CASH")
            .debit("50.00", "EUR")
            .actor("alice")
            .account("REVENUE")
            .credit("50.00", "EUR")
            .build());

    assertThat(ledger.getTransactionByRef("T1").getActor()).isEqualTo("alice");
  }

  @Test
  void aTransferWithoutActorKeepsTheOldBehaviour() {
    Ledger ledger = AcceptanceSupport.ledger("r4-no-actor", "1000.00");

    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "50.00"));

    assertThat(ledger.getTransactionByRef("T1").getActor()).isNull();
    AcceptanceSupport.assertAmount(ledger.getAccountBalance("CASH"), "950.00");
  }

  @Test
  void postingsAreListedPerAccountInSubmissionOrder() {
    Ledger ledger = AcceptanceSupport.ledger("r4-history", "1000.00");
    ledger.commit(AcceptanceSupport.payment(ledger, "T1", "10.00"));
    ledger.commit(AcceptanceSupport.payment(ledger, "T2", "20.00"));
    PostingHistoryService history = ledger.postingHistoryService();

    List<AccountPosting> postings = history.listPostings("CASH");

    assertThat(postings).hasSize(2);
    assertThat(postings.get(0).getTransactionRef()).isEqualTo("T1");
    assertThat(postings.get(1).getTransactionRef()).isEqualTo("T2");
    assertThat(postings.get(0).getTransactionType()).isEqualTo("payout");
    assertThat(postings.get(0).getActor()).isNull();
    AcceptanceSupport.assertAmountAbs(postings.get(0).getAmount(), "10.00");
    assertThat(postings.get(0).getTimestamp()).isNotNull();
  }

  @Test
  void anAccountWithoutPostingsReturnsAnEmptyList() {
    Ledger ledger = AcceptanceSupport.ledger("r4-empty", "1000.00");

    List<AccountPosting> postings = ledger.postingHistoryService().listPostings("CASH");

    assertThat(postings).isEmpty();
  }

  @Test
  void theActorIsShownInThePostingHistory() {
    Ledger ledger = AcceptanceSupport.ledger("r4-actor-history", "1000.00");

    ledger.commit(
        ledger
            .createTransferRequest()
            .reference("T1")
            .type("sale")
            .account("CASH")
            .debit("50.00", "EUR")
            .actor("bob")
            .account("REVENUE")
            .credit("50.00", "EUR")
            .build());

    List<AccountPosting> postings = ledger.postingHistoryService().listPostings("CASH");

    assertThat(postings).hasSize(1);
    assertThat(postings.get(0).getActor()).isEqualTo("bob");
  }
}
